import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { findRoot } from "./config.ts";
import type { Diagnostic as Found } from "./diagnostic.ts";
import { gitIgnored, listComponents, type ListMode } from "./files.ts";
import { glob } from "./glob.ts";
import {
  filterComponents,
  lint as lintComponents,
  lintAndFix,
} from "./lint.ts";
import { locate } from "./report.ts";
import type {
  Diagnostic,
  LintOptions,
  LintResult,
  Skipped,
  Watcher,
  WatchOptions,
} from "./types.ts";
import { watchComponents } from "./watch.ts";

/** A path's own segment, or a parent's, that starts with a dot. */
const DOT_FOLDER = /(^|\/)\.[^./]/;

const isUnder = (file: string, path: string) =>
  path === "" || file === path || file.startsWith(`${path}/`);

/**
 * The components at a named `path`, relative to `root`, that the list
 * of components leaves out: git ignores them, or they're in a dot folder.
 */
function componentsAt(root: string, path: string): string[] {
  if (statSync(join(root, path)).isFile())
    return path.endsWith(".svelte") ? [path] : [];
  return glob(join(root, path), ["**/*.svelte"]).map((f) => `${path}/${f}`);
}

/**
 * The project root, its components under `paths`, `paths` relative to
 * the root, and the named files it skips. As `bun lint` does, it lints
 * a named path git ignores, skips a named file `ignorePatterns` skip,
 * and throws for a path that doesn't exist, is outside the project, or
 * is a folder with no component to lint.
 */
export async function select(
  cwd: string,
  paths: string[],
  mode: ListMode,
): Promise<{
  root: string;
  files: string[];
  paths: string[];
  skipped: Skipped[];
}> {
  const root = findRoot(cwd);
  // git runs while the paths resolve.
  const listed = listComponents(root, mode);
  const named = paths.map((path) => {
    const absolute = resolve(cwd, path);
    const scoped = relative(root, absolute).replaceAll("\\", "/");
    if (!existsSync(absolute))
      throw new Error(`${path}: no such file or folder`);
    if (scoped === ".." || scoped.startsWith("../") || isAbsolute(scoped))
      throw new Error(`${path} is outside the project, ${root}`);
    return { path, scoped };
  });
  // --staged and --changed pick from what git sees, and may pick none.
  const all = mode.staged || mode.changed != null;
  const found = new Set(await listed);
  if (!all && named.length > 0) {
    const ignored = await gitIgnored(
      root,
      named.map((n) => n.scoped).filter(Boolean),
    );
    for (const { scoped } of named) {
      if (ignored.has(scoped) || DOT_FOLDER.test(scoped))
        for (const file of componentsAt(root, scoped)) found.add(file);
    }
  }
  const scopedFound = [...found].filter(
    (file) =>
      named.length === 0 || named.some(({ scoped }) => isUnder(file, scoped)),
  );
  const files = filterComponents(root, scopedFound);
  const skipped: Skipped[] = [];
  if (!all) {
    const kept = new Set(files);
    for (const { path, scoped } of named) {
      if (statSync(join(root, scoped)).isFile()) {
        if (!scoped.endsWith(".svelte"))
          skipped.push({ path, reason: "not a component" });
        else if (!kept.has(scoped)) skipped.push({ path, reason: "ignored" });
        continue;
      }
      const under = scopedFound.filter((file) => isUnder(file, scoped));
      if (under.length === 0) throw new Error(`${path} has no components`);
      if (!under.some((file) => kept.has(file)))
        throw new Error(
          `${path}: ignorePatterns in bunfig.toml skip every component in it`,
        );
    }
  }
  return { root, files, paths: named.map((n) => n.scoped), skipped };
}

/**
 * Problems with lines and columns, without the frame's lines `report`
 * keeps.
 */
function located(found: Found[], sources: Map<string, string>): Diagnostic[] {
  return locate(found, sources).map(({ lines: _, ...d }) => d);
}

export const count = (
  diagnostics: readonly { severity: string }[],
): {
  errors: number;
  warnings: number;
} => {
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  return { errors, warnings: diagnostics.length - errors };
};

export async function lint(options: LintOptions = {}): Promise<LintResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const { root, files, skipped } = await select(cwd, options.paths ?? [], {
    staged: options.staged,
    changed: options.changed,
  });
  const run = options.fix ? lintAndFix : lintComponents;
  const result = await run(root, files, { cache: options.cache ?? true });
  const diagnostics = located(result.diagnostics, result.sources);
  return { root, files, skipped, diagnostics, ...count(diagnostics) };
}

export async function watch(options: WatchOptions): Promise<Watcher> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const { root, files, paths } = await select(cwd, options.paths ?? [], {});
  return watchComponents({
    root,
    files,
    paths,
    cache: options.cache ?? true,
    onUpdate: ({ sources, diagnostics, ...update }) =>
      options.onUpdate({
        ...update,
        diagnostics: located(diagnostics, sources),
      }),
  });
}
