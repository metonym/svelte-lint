// Compiles components with the project's Svelte, off the main thread.
// `compilerWarnings` posts `{ path, jobs }` and gets the warnings back,
// one list per job.
import { compileAll, type CompileRequest } from "./compile.ts";

declare const self: Worker;

self.onmessage = async ({ data }: MessageEvent<CompileRequest>) => {
  self.postMessage(await compileAll(data.path, data.jobs));
};
