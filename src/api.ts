import { relative, resolve } from "node:path";
import { findRoot } from "./config.ts";
import type { Diagnostic as Found } from "./diagnostic.ts";
import { listComponents, type ListMode } from "./files.ts";
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
  Watcher,
  WatchOptions,
} from "./types.ts";
import { watchComponents } from "./watch.ts";

/** The project root, its components under `paths`, and `paths` relative to the root. */
export async function select(
  cwd: string,
  paths: string[],
  mode: ListMode,
): Promise<{ root: string; files: string[]; paths: string[] }> {
  const root = findRoot(cwd);
  // git runs while the paths resolve.
  const listed = listComponents(root, mode);
  const scoped = paths.map((p) =>
    relative(root, resolve(cwd, p)).replaceAll("\\", "/"),
  );
  const files = filterComponents(root, await listed).filter(
    (file) =>
      scoped.length === 0 ||
      scoped.some((p) => p === "" || file === p || file.startsWith(`${p}/`)),
  );
  return { root, files, paths: scoped };
}

/** Problems with lines and columns, without the frame's lines `report` keeps. */
function located(found: Found[], sources: Map<string, string>): Diagnostic[] {
  return locate(found, sources).map(({ lines: _, ...d }) => d);
}

export const count = (diagnostics: readonly { severity: string }[]) => {
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  return { errors, warnings: diagnostics.length - errors };
};

export async function lint(options: LintOptions = {}): Promise<LintResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const { root, files } = await select(cwd, options.paths ?? [], {
    staged: options.staged,
    changed: options.changed,
  });
  const run = options.fix ? lintAndFix : lintComponents;
  const result = await run(root, files, { cache: options.cache ?? true });
  const diagnostics = located(result.diagnostics, result.sources);
  return { root, files, diagnostics, ...count(diagnostics) };
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
