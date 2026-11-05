import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Analysis } from "./analyze.ts";
import { moduleBunfig } from "./config.ts";
import { type Diagnostic, type Fix, lineStarts, offset } from "./diagnostic.ts";
import { toSource } from "./emit.ts";

/** A component and its module, for `bun lint`. */
export interface Component {
  file: string;
  source: string;
  module: NonNullable<Analysis["module"]>;
}

interface EslintMessage {
  ruleId: string | null;
  severity: 1 | 2;
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  fix?: { range: [number, number]; text: string };
}

interface EslintResult {
  filePath: string;
  messages: EslintMessage[];
}

const SEPARATOR = /[\\/]/;

const modulePath = (component: Component): string =>
  `${component.file}.${component.module.typescript ? "ts" : "js"}`;

/**
 * Starts linting the components' scripts and markup expressions with
 * `bun lint`, using `[lint]` from `bunfig.toml`: it returns once the
 * modules are written and `bun lint` runs, so the caller can analyze more
 * components meanwhile. `done` has the problems mapped back to the
 * components, by file. Each batch needs its own `id`.
 */
export async function startScriptLint(
  root: string,
  bunfig: Record<string, unknown>,
  components: Component[],
  id = 0,
): Promise<{ done: Promise<Map<string, Diagnostic[]>> }> {
  const byFile = new Map<string, Diagnostic[]>(
    components.map((c) => [c.file, []]),
  );
  if (components.length === 0) return { done: Promise.resolve(byFile) };
  // Outside the repository, so its `.gitignore` doesn't hide the modules.
  const dir = join(
    tmpdir(),
    `svelte-lint-${createHash("sha1").update(root).digest("hex").slice(0, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  writeIfChanged(join(dir, "bunfig.toml"), moduleBunfig(bunfig, root));
  const byModule = new Map<string, Component>();
  for (const component of components)
    byModule.set(modulePath(component), component);
  for (const folder of new Set(
    [...byModule.keys()].map((path) => dirname(join(dir, path))),
  )) {
    mkdirSync(folder, { recursive: true });
  }
  // In parallel, 3x faster than one at a time. bun lint keeps no cache, so
  // there's no modification time to preserve by skipping unchanged ones.
  await Promise.all(
    [...byModule].map(([path, component]) =>
      Bun.write(join(dir, path), component.module.code),
    ),
  );
  // Per process too: another run, such as `--watch`, may lint the same project.
  const report = join(dir, `.report-${process.pid}-${id}.json`);
  rmSync(report, { force: true });
  const child = Bun.spawn(
    [
      process.execPath,
      `--config=${join(dir, "bunfig.toml")}`,
      "lint",
      "--no-script",
      "--format=json",
      `--output-file=${report}`,
      ...byModule.keys(),
    ],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  );
  return { done: collectReport(child, report, byModule, byFile) };
}

async function collectReport(
  child: Bun.Subprocess<"ignore", "pipe", "pipe">,
  report: string,
  byModule: Map<string, Component>,
  byFile: Map<string, Diagnostic[]>,
): Promise<Map<string, Diagnostic[]>> {
  const [stderr] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (!existsSync(report)) {
    throw new Error(
      `bun lint didn't write a report: svelte-lint needs a Bun with \`bun lint\`, 1.4.5 or a canary build, and runs ${process.execPath} (${Bun.version}).\n${stderr}`,
    );
  }
  const results = JSON.parse(readFileSync(report, "utf8")) as EslintResult[];
  rmSync(report, { force: true });
  for (const result of results) {
    if (result.messages.length === 0) continue;
    const component = moduleFor(byModule, result.filePath);
    if (!component) continue;
    const starts = lineStarts(component.module.code);
    const list = byFile.get(component.file) ?? [];
    for (const message of result.messages) {
      const diagnostic = toDiagnostic(component, starts, message);
      if (diagnostic && !isSvelteIdiom(component, diagnostic))
        list.push(diagnostic);
    }
  }
  return byFile;
}

/**
 * The component whose module bun lint reports at `filePath`: the longest
 * trailing run of its segments that names a module. Not by stripping the
 * temporary folder's path, which on Windows bun lint may spell with other
 * separators, casing or long names than `tmpdir()` does.
 */
export function moduleFor<T>(
  byModule: Map<string, T>,
  filePath: string,
): T | undefined {
  const segments = filePath.split(SEPARATOR);
  for (let n = 0; n < segments.length; n++) {
    const component = byModule.get(segments.slice(n).join("/"));
    if (component) return component;
  }
  return undefined;
}

function writeIfChanged(path: string, text: string): void {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return;
  writeFileSync(path, text);
}

function toDiagnostic(
  component: Component,
  starts: number[],
  message: EslintMessage,
): Diagnostic | null {
  const { module } = component;
  const moduleStart = offset(starts, message.line, message.column);
  const moduleEnd =
    message.endLine != null && message.endColumn != null
      ? offset(starts, message.endLine, message.endColumn)
      : moduleStart;
  const start = toSource(module, moduleStart);
  // A problem in the generated part, such as an unused `eslint-disable`.
  if (start == null) return null;
  const end = toSource(module, moduleEnd) ?? start;
  let fix: Fix | undefined;
  if (message.fix) {
    const [a, b] = message.fix.range;
    const fixStart = toSource(module, a);
    const fixEnd = toSource(module, b);
    // Only a fix that stays inside one script or one expression.
    if (fixStart != null && fixEnd != null && fixEnd - fixStart === b - a) {
      fix = { start: fixStart, end: fixEnd, text: message.fix.text };
    }
  }
  return {
    file: component.file,
    rule: message.ruleId,
    severity: message.severity === 2 ? "error" : "warn",
    message: message.message,
    start,
    end: Math.max(end, start),
    fix,
  };
}

const TYPESCRIPT_ESLINT = /^@typescript-eslint\//;
const RULE = (id: string | null): string =>
  (id ?? "").replace(TYPESCRIPT_ESLINT, "");

// The props, events and slots of a TypeScript component, which Svelte reads.
const SVELTE_TYPES = new Set(["$$Props", "$$Events", "$$Slots"]);

/**
 * Problems in JavaScript that are how Svelte works, so the rules that
 * report them can stay on for components and still catch the rest:
 *
 * - `no-self-assign`: `items = items` tells a legacy component that
 *   `items` changed, for a top-level variable of its `<script>`. Anywhere
 *   else, and in runes mode, it does nothing.
 * - `no-unused-labels`: a top-level `$:` is a reactive statement. Inside
 *   a function it's a label nothing uses.
 * - `no-undef-init`: `export let size = undefined` declares an optional prop.
 * - `prefer-const`: props from `$props()` and `$derived` values are
 *   declared with `let`, as Svelte's docs do.
 * - `no-unused-vars`: `$$Props`, `$$Events` and `$$Slots` type the
 *   component.
 */
export function isSvelteIdiom(
  component: Component,
  diagnostic: Diagnostic,
): boolean {
  const { facts } = component.module;
  const { start } = diagnostic;
  switch (RULE(diagnostic.rule)) {
    case "no-self-assign":
      return !facts.runes && facts.instance.includes(start);
    case "no-unused-labels":
      return (
        !facts.runes &&
        facts.labels.some(([from, to]) => from <= start && start <= to)
      );
    case "no-undef-init":
      return !facts.runes && facts.props.includes(start);
    case "prefer-const":
      return facts.letRunes.includes(start);
    case "no-unused-vars":
      return SVELTE_TYPES.has(component.source.slice(start, diagnostic.end));
    default:
      return false;
  }
}
