import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compileAll, compilerWarnings } from "../src/compile.ts";
import { FIXTURES } from "./shared.ts";

describe("compilerWarnings", () => {
  it("warns the same in Workers as on the main thread, in order", async () => {
    const scoped = `<div class="a"></div>\n\n<style>\n  .b {\n    color: red;\n  }\n</style>\n`;
    const clean = await readFile(join(FIXTURES, "src/Clean.svelte"), "utf8");
    // Enough components for Workers, alternating so order shows.
    const jobs = Array.from({ length: 400 }, (_, n) => ({
      file: `src/C${n}.svelte`,
      source: n % 2 ? scoped : clean,
    }));
    const path = Bun.resolveSync("svelte/compiler", FIXTURES);
    const inWorkers = await compilerWarnings(FIXTURES, jobs);
    expect(inWorkers).toEqual(await compileAll(path, jobs));
    expect(inWorkers[1].map((w) => w.code)).toEqual(["css_unused_selector"]);
    expect(inWorkers[0]).toEqual([]);
  });
});
