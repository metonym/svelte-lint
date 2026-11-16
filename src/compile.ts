import { availableParallelism } from "node:os";
import type { compile } from "svelte/compiler";

export interface Job {
  file: string;
  source: string;
}

export interface CompilerWarning {
  code: string;
  message: string;
  start: number;
  end: number;
}

export interface CompileRequest {
  /** `svelte/compiler`, resolved from the project. */
  path: string;
  jobs: Job[];
}

type Compile = typeof compile;
const compilers = new Map<string, Promise<Compile>>();

/** Each job's warnings from the compiler at `path`, but its a11y ones. */
export async function compileAll(
  path: string,
  jobs: Job[],
): Promise<CompilerWarning[][]> {
  let load = compilers.get(path);
  if (!load) {
    load = import(path).then((m: { compile: Compile }) => m.compile);
    compilers.set(path, load);
  }
  const run = await load;
  return jobs.map(({ file, source }) => {
    try {
      return run(source, { filename: file, generate: false } as never)
        .warnings.filter((w) => !w.code.startsWith("a11y"))
        .map((w) => ({
          code: w.code,
          // The first line; the second links to the docs.
          message: w.message.split("\n")[0],
          start: w.start?.character ?? 0,
          end: w.end?.character ?? w.start?.character ?? 0,
        }));
    } catch {
      // A compile error the parser didn't catch, such as a bad rune call,
      // which the compiler reports when the component builds.
      return [];
    }
  });
}

/**
 * Below this many components, a Worker's start, about 30 ms with the
 * compiler's import, costs more than it saves.
 */
const PER_WORKER = 100;
// Each Worker warms its own JIT, and `bun lint` runs alongside. On 2,251
// components, 2 Workers cut a cold run from 1.64s to 1.30s; 4 cut no more.
const MAX_WORKERS = 2;

/**
 * The project's Svelte compiler's warnings for each component, but its
 * a11y ones, which `analyze` has, so Svelte 3, 4 and 5 each warn as they
 * compile. Many components compile in Workers, in parallel and off the
 * main thread, which analyzes meanwhile.
 */
export async function compilerWarnings(
  root: string,
  jobs: Job[],
): Promise<CompilerWarning[][]> {
  if (jobs.length === 0) return [];
  let path: string;
  try {
    path = Bun.resolveSync("svelte/compiler", root);
  } catch {
    throw new Error(
      `"svelte/compiler" is on in [svelte-lint], but svelte isn't installed in ${root}`,
    );
  }
  const workers = Math.min(
    MAX_WORKERS,
    availableParallelism() - 1,
    Math.floor(jobs.length / PER_WORKER),
  );
  if (workers < 2) return compileAll(path, jobs);
  // The source next to this file in src/, the bundle's own in dist/.
  const url = new URL(
    import.meta.url.endsWith(".ts")
      ? "./compile-worker.ts"
      : "./compile-worker.js",
    import.meta.url,
  );
  const parts = await Promise.all(
    Array.from({ length: workers }, (_, n) => {
      const part = jobs.slice(
        Math.floor((n * jobs.length) / workers),
        Math.floor(((n + 1) * jobs.length) / workers),
      );
      const worker = new Worker(url);
      return new Promise<CompilerWarning[][]>((resolve, reject) => {
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = (event) => reject(event.error ?? event);
        worker.postMessage({ path, jobs: part } satisfies CompileRequest);
      }).finally(() => worker.terminate());
    }),
  );
  return parts.flat();
}
