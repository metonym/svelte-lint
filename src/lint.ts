import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Analysis, CompilerWarning, Job } from "./analyze.ts";
import { cacheKey, type Entry, hash, loadCache, saveCache } from "./cache.ts";
import { rulesFor, type Severity, templateConfig } from "./config.ts";
import type { Diagnostic } from "./diagnostic.ts";
import type { Component } from "./script-rules.ts";
import { templateRules } from "./template-rules.ts";

// Batches to analyze and lint in turn: each bun lint process costs about
// 35 ms to start, so a few, and none below a couple hundred components.
const BATCHES = 4;
const PER_BATCH = 200;

/** Every template rule and compiler pass is on unless `[svelte-lint]` turns it off. */
const DEFAULT_RULES: Record<string, Severity> = {
  ...Object.fromEntries(
    Object.keys(templateRules).map((name) => [name, "error"]),
  ),
  "svelte/a11y": "error",
  "svelte/compiler": "off",
};

export interface LintResult {
  diagnostics: Diagnostic[];
  sources: Map<string, string>;
}

const byPosition = (a: Diagnostic, b: Diagnostic) =>
  a.file.localeCompare(b.file) || a.start - b.start;

/**
 * The config and cache a run reads, which watch mode keeps between runs
 * instead of reading them again.
 */
export interface Session {
  bunfig: Record<string, unknown>;
  config: ReturnType<typeof templateConfig>;
  key: string;
  cache: Record<string, Entry>;
}

export function openSession(
  root: string,
  options: { cache: boolean } = { cache: true },
): Session {
  const bunfigPath = join(root, "bunfig.toml");
  const bunfigText = existsSync(bunfigPath)
    ? readFileSync(bunfigPath, "utf8")
    : "";
  const bunfig = Bun.TOML.parse(bunfigText) as Record<string, unknown>;
  const key = cacheKey(root, bunfigText);
  return {
    bunfig,
    config: templateConfig(bunfig, DEFAULT_RULES),
    key,
    cache: options.cache ? loadCache(root, key) : {},
  };
}

export interface LintOptions {
  cache: boolean;
  /** Reuse the config and cache of earlier runs. */
  session?: Session;
  /**
   * Called with the problems the template rules and the a11y checks find
   * in the components that changed, before bun lint's are in.
   */
  onTemplate?: (
    diagnostics: Diagnostic[],
    files: string[],
    sources: Map<string, string>,
  ) => void;
}

/** Whether `bun lint` reported it, rather than svelte-lint itself. */
export const isScriptProblem = (d: Diagnostic): boolean =>
  d.rule !== null && !d.rule.startsWith("svelte/");

/**
 * Lints `files`, paths relative to `root`, with the config in `root`'s
 * `bunfig.toml`. A component whose source hasn't changed since the last
 * run gets its problems from `node_modules/.cache/svelte-lint` without
 * being read, parsed or linted.
 */
export async function lint(
  root: string,
  files: string[],
  options: LintOptions = { cache: true },
): Promise<LintResult> {
  const session = options.session ?? openSession(root, options);
  const { bunfig, config, key, cache } = session;

  const sources = new Map<string, string>();
  const meta = new Map<string, { hash: string; size: number; mtime: number }>();
  let changed = false;
  const severities = new Map<string, Record<string, Severity>>();
  const diagnostics: Diagnostic[] = [];
  const jobs: Job[] = [];
  const compileJobs: Job[] = [];
  // Unchanged since the last run, by size and time, so not read at all
  // unless its problems are printed. The rest are read in parallel, 2 to
  // 10x faster than one at a time.
  const stats = files.map((file) => statSync(join(root, file)));
  const unchanged = files.map((file, n) => {
    const cached = cache[file];
    return (
      cached != null &&
      cached.size === stats[n].size &&
      cached.mtime === stats[n].mtimeMs
    );
  });
  const read = await Promise.all(
    files.map((file, n) =>
      !unchanged[n] || (cache[file]?.diagnostics.length ?? 0) > 0
        ? Bun.file(join(root, file)).text()
        : undefined,
    ),
  );
  for (const [n, file] of files.entries()) {
    const cached = cache[file];
    const source = read[n];
    if (source !== undefined) sources.set(file, source);
    if (unchanged[n] && cached) {
      diagnostics.push(...cached.diagnostics);
      continue;
    }
    const size = stats[n].size;
    const mtime = stats[n].mtimeMs;
    const sourceHash = hash(source ?? "");
    meta.set(file, { hash: sourceHash, size, mtime });
    // Touched, as by a checkout, but the same.
    if (cached?.hash === sourceHash) {
      cache[file] = { ...cached, size, mtime };
      changed = true;
      diagnostics.push(...cached.diagnostics);
      continue;
    }
    const rules = rulesFor(config, file);
    severities.set(file, rules);
    jobs.push({ file, source: source ?? "" });
    if (rules["svelte/compiler"] !== "off")
      compileJobs.push({ file, source: source ?? "" });
  }

  // The parser and bun lint's runner load only when something changed.
  const [analysis, scriptRules] =
    jobs.length > 0
      ? await Promise.all([import("./analyze.ts"), import("./script-rules.ts")])
      : [null, null];
  // bun lint runs in its own process, so it lints each batch while the
  // next one is analyzed here, and the compiler runs after.
  const analyses: Analysis[] = [];
  const started: { done: Promise<Map<string, Diagnostic[]>> }[] = [];
  const batches = Math.min(BATCHES, Math.ceil(jobs.length / PER_BATCH));
  for (let n = 0; analysis && scriptRules && n < batches; n++) {
    const batch = jobs
      .slice(
        Math.floor((n * jobs.length) / batches),
        Math.floor(((n + 1) * jobs.length) / batches),
      )
      .map(analysis.analyze);
    analyses.push(...batch);
    const components: Component[] = batch.flatMap((a) =>
      a.module
        ? [
            {
              file: a.file,
              source: sources.get(a.file) ?? "",
              module: a.module,
            },
          ]
        : [],
    );
    // This awaits the writes and the spawn, not the lint.
    // eslint-disable-next-line no-await-in-loop
    const lintStarted = await scriptRules.startScriptLint(
      root,
      bunfig,
      components,
      n,
    );
    started.push(lintStarted);
  }
  options.onTemplate?.(
    analyses.flatMap((a) => collect(a, severities.get(a.file) ?? {}, [], [])),
    analyses.map((a) => a.file),
    sources,
  );
  const warnings = analysis
    ? await analysis.compilerWarnings(root, compileJobs)
    : [];
  const scripts = new Map<string, Diagnostic[]>();
  for (const result of await Promise.all(started.map((s) => s.done))) {
    for (const [file, found] of result) scripts.set(file, found);
  }
  const compiled = new Map(
    compileJobs.map((job, n) => [job.file, warnings[n]]),
  );
  for (const analyzed of analyses) {
    const found = collect(
      analyzed,
      severities.get(analyzed.file) ?? {},
      scripts.get(analyzed.file) ?? [],
      compiled.get(analyzed.file) ?? [],
    );
    cache[analyzed.file] = {
      ...(meta.get(analyzed.file) ?? { hash: "", size: -1, mtime: -1 }),
      diagnostics: found,
    };
    diagnostics.push(...found);
  }
  if (options.cache && (jobs.length > 0 || changed)) {
    // Drop components that are gone; watch mode drops them as they go.
    if (!options.session) {
      for (const file of Object.keys(cache)) {
        if (!existsSync(join(root, file))) delete cache[file];
      }
    }
    saveCache(root, key, cache);
  }
  return { diagnostics: diagnostics.sort(byPosition), sources };
}

/** A component's problems, with each template rule and compiler warning at its configured severity. */
function collect(
  analysis: Analysis,
  rules: Record<string, Severity>,
  scripts: Diagnostic[],
  compiler: CompilerWarning[],
): Diagnostic[] {
  if (analysis.syntax) return [analysis.syntax];
  const found: Diagnostic[] = [...scripts];
  for (const d of analysis.template) {
    const level = rules[d.rule ?? ""] ?? "off";
    if (level !== "off") found.push({ ...d, severity: level });
  }
  for (const [rule, warnings] of [
    ["svelte/a11y", analysis.a11y],
    ["svelte/compiler", compiler],
  ] as const) {
    const level = rules[rule] ?? "off";
    if (level === "off") continue;
    for (const warning of warnings) {
      found.push({
        file: analysis.file,
        rule: `svelte/${warning.code}`,
        severity: level,
        // The first line; the second links to the docs.
        message: warning.message.split("\n")[0],
        start: warning.start,
        end: warning.end,
        help: `Fix it, or add <!-- svelte-ignore ${warning.code} --> above it.`,
      });
    }
  }
  return found;
}

/**
 * Applies each file's fixes that don't overlap, then lints the fixed files
 * again, as ESLint does, until nothing is left to fix or after 10 passes.
 */
export async function lintAndFix(
  root: string,
  files: string[],
  options: LintOptions = { cache: true },
): Promise<LintResult> {
  let result = await lint(root, files, options);
  for (let pass = 0; pass < 10; pass++) {
    const fixed = new Set<string>();
    const byFile = Map.groupBy(
      result.diagnostics.filter((d) => d.fix),
      (d) => d.file,
    );
    for (const [file, list] of byFile) {
      let source = result.sources.get(file) ?? "";
      let last = Number.POSITIVE_INFINITY;
      for (const { fix } of list.sort(
        (a, b) => (b.fix?.start ?? 0) - (a.fix?.start ?? 0),
      )) {
        if (!fix || fix.end > last) continue;
        source = source.slice(0, fix.start) + fix.text + source.slice(fix.end);
        last = fix.start;
      }
      writeFileSync(join(root, file), source);
      fixed.add(file);
    }
    if (fixed.size === 0) break;
    // Each pass lints what the one before it fixed.
    // eslint-disable-next-line no-await-in-loop
    const again = await lint(root, [...fixed], options);
    const rest = result.diagnostics.filter((d) => !fixed.has(d.file));
    for (const [file, source] of again.sources)
      result.sources.set(file, source);
    result = {
      diagnostics: [...rest, ...again.diagnostics].sort(byPosition),
      sources: result.sources,
    };
  }
  return result;
}

/** `files` that exist and that `[svelte-lint]`'s `ignorePatterns` don't skip. */
export function filterComponents(root: string, files: string[]): string[] {
  const bunfigPath = join(root, "bunfig.toml");
  const bunfig = existsSync(bunfigPath)
    ? Bun.TOML.parse(readFileSync(bunfigPath, "utf8"))
    : {};
  const config = templateConfig(
    bunfig as Record<string, unknown>,
    DEFAULT_RULES,
  );
  const ignore = config.ignorePatterns.map((p) => new Bun.Glob(p));
  return [...new Set(files)].filter(
    (file) =>
      existsSync(join(root, file)) && !ignore.some((glob) => glob.match(file)),
  );
}
