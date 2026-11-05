import { existsSync, watch as watchFiles } from "node:fs";
import { join } from "node:path";
import type { Diagnostic } from "./diagnostic.ts";
import {
  filterComponents,
  isScriptProblem,
  lint,
  type LintOptions,
  openSession,
  type Session,
} from "./lint.ts";

/** What a watch knows after a change, for its caller to print. */
interface Update {
  /**
   * `template`: the template rules and a11y checks are in, and bun lint's
   * problems from before the change stand until its new ones are.
   * `done`: everything is in. `removed`: components were deleted.
   */
  stage: "template" | "done" | "removed";
  /** The components this update is about, relative to the root. */
  changed: string[];
  /** Every component's problems. */
  diagnostics: Diagnostic[];
  /** The sources of the components with problems. */
  sources: Map<string, string>;
  /** How many components are watched. */
  files: number;
  /** Milliseconds since the change, to this update. */
  ms: number;
  /** Why it ran: the change, or `bunfig.toml` for a config change. */
  reason: "start" | "change" | "config";
}

export interface WatchOptions {
  root: string;
  files: string[];
  /** Only components under these paths, relative to `root`, if any. */
  paths: string[];
  cache: boolean;
  onUpdate: (update: Update) => void;
}

// Editors save in bursts (a temporary file, a rename, the file), so
// changes within this long are linted together.
const DEBOUNCE_MS = 20;
// Directories whose `.svelte` files aren't the project's.
const SKIPPED = /(^|\/)(node_modules|\.[^/]+)\//;

/**
 * Lints the components, then again each time one changes, with what the
 * first run loaded still in memory: the parser, the config and the cache.
 * The template rules and a11y checks report first, a few milliseconds
 * after a save; bun lint's problems follow when its process is done,
 * which is most of the time a change takes. A change to `bunfig.toml`
 * lints every component again with the new rules.
 */
export async function watchComponents(
  options: WatchOptions,
): Promise<{ close: () => void }> {
  const { root, paths, onUpdate } = options;
  const lintOptions: LintOptions = { cache: options.cache };
  let session: Session = openSession(root, lintOptions);
  const files = new Set(options.files);
  const byFile = new Map<string, Diagnostic[]>();
  const sources = new Map<string, string>();

  const inScope = (file: string) =>
    paths.length === 0 ||
    paths.some((p) => p === "" || file === p || file.startsWith(`${p}/`));

  const emit = (
    stage: Update["stage"],
    changed: string[],
    started: number,
    reason: Update["reason"],
  ) =>
    onUpdate({
      stage,
      changed,
      diagnostics: [...byFile.values()].flat(),
      sources,
      files: files.size,
      ms: performance.now() - started,
      reason,
    });

  const run = async (changed: string[], reason: Update["reason"]) => {
    const started = performance.now();
    const result = await lint(root, changed, {
      ...lintOptions,
      session,
      onTemplate: (found, analyzed, read) => {
        if (reason === "start" || analyzed.length === 0) return;
        // The new sources, so the problems' lines are the new ones.
        for (const file of analyzed) {
          const source = read.get(file);
          if (source !== undefined) sources.set(file, source);
        }
        // bun lint's problems from before the change stay until its new
        // ones are in, so the list doesn't flicker.
        for (const file of analyzed) {
          byFile.set(file, (byFile.get(file) ?? []).filter(isScriptProblem));
        }
        for (const d of found) byFile.get(d.file)?.push(d);
        emit("template", analyzed, started, reason);
      },
    });
    for (const [file, source] of result.sources) sources.set(file, source);
    for (const file of changed) byFile.set(file, []);
    for (const d of result.diagnostics) byFile.get(d.file)?.push(d);
    emit("done", changed, started, reason);
  };

  await run([...files], "start");

  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  let configChanged = false;

  const flush = () => {
    const changed = [...pending];
    const reload = configChanged;
    pending = new Set();
    configChanged = false;
    running = running.then(async () => {
      if (reload) {
        session = openSession(root, lintOptions);
        byFile.clear();
        await run([...files], "config");
        return;
      }
      const gone = changed.filter((file) => !existsSync(join(root, file)));
      for (const file of gone) {
        files.delete(file);
        byFile.delete(file);
        sources.delete(file);
        delete session.cache[file];
      }
      const present = filterComponents(root, changed);
      for (const file of present) files.add(file);
      if (present.length > 0) await run(present, "change");
      else if (gone.length > 0)
        emit("removed", gone, performance.now(), "change");
    });
  };

  const watcher = watchFiles(root, { recursive: true }, (_event, name) => {
    if (!name) return;
    const file = name.toString().replaceAll("\\", "/");
    if (file === "bunfig.toml") configChanged = true;
    else if (file.endsWith(".svelte") && !SKIPPED.test(file) && inScope(file))
      pending.add(file);
    else return;
    clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  });

  return {
    close: () => {
      clearTimeout(timer);
      watcher.close();
    },
  };
}
