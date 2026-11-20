import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { compile } from "svelte/compiler";
import { analyze, type CompilerWarning, type Job } from "../src/analyze.ts";
import { FIXTURES } from "./shared.ts";

/** Components for the warnings svelte-lint's users meet most, and their edges. */
const GENERATED: Record<string, string> = {
  "Unused.svelte": `<div class="a"></div>\n\n<style>\n  .a { color: red; }\n  .b { color: blue; }\n  div :global(.c) { color: green; }\n</style>\n`,
  "Dynamic.svelte": `<script>\n  let { open } = $props();\n</script>\n\n<div class:open class={open ? "x" : "y"}></div>\n\n<style>\n  .open, .x, .z { color: red; }\n</style>\n`,
  "Ignored.svelte": `<div class="a"></div>\n\n<!-- svelte-ignore css_unused_selector -->\n<style>\n  .b { color: blue; }\n</style>\n`,
  "Empty.svelte": `<script>\n  let { x } = $props();\n</script>\n\n{#if x} {/if}\n{#each [x] as y}{y}{/each}\n`,
  "Local.svelte": `<script>\n  let { value } = $props();\n  let count = $state(value);\n  const doubled = count * 2;\n</script>\n\n<p>{doubled}</p>\n`,
  "Update.svelte": `<script>\n  let { label } = $props();\n  let n = 0;\n</script>\n\n<button onclick={() => n++}>{label}{n}</button>\n`,
  "SelfClosing.svelte": `<script>\n  let { x } = $props();\n</script>\n\n<div />\n<span/>{x}\n`,
  "Deprecated.svelte": `<script>\n  let { x } = $props();\n</script>\n\n<button on:click={() => x}>x</button>\n<slot />\n`,
  "Legacy.svelte": `<script>\n  export let unused;\n  export let used;\n  $: doubled = used * 2;\n</script>\n\n<p>{doubled}</p>\n`,
  "Scss.svelte": `<div class="a"></div>\n\n<style lang="scss">\n  $c: red;\n  .a { .b { color: $c; } }\n</style>\n`,
  "IgnoredScript.svelte": `<script>\n  let { value } = $props();\n  // svelte-ignore state_referenced_locally\n  let count = $state(value);\n  const doubled = count * 2;\n</script>\n\n<p>{doubled}</p>\n`,
};

/** What Svelte 5's `compile` warns, but the a11y warnings, as svelte-ast gives them. */
function compiled({ file, source }: Job): CompilerWarning[] {
  try {
    return compile(source, { filename: file, generate: false })
      .warnings.filter((w) => !w.code.startsWith("a11y"))
      .map((w) => ({
        code: w.code,
        message: w.message,
        start: w.start?.character ?? 0,
        end: w.end?.character ?? w.start?.character ?? 0,
      }));
  } catch {
    // A component Svelte can't compile, such as one whose CSS is Sass.
    return [];
  }
}

describe("svelte/compiler from svelte-ast", () => {
  it("warns as the project's Svelte 5 compiles, on the fixtures and generated components", async () => {
    const fixtures = await Promise.all(
      (await readdir(join(FIXTURES, "src")))
        .filter((name) => name.endsWith(".svelte"))
        .map(async (name) => ({
          file: `src/${name}`,
          source: await readFile(join(FIXTURES, "src", name), "utf8"),
        })),
    );
    const jobs: Job[] = [
      ...fixtures,
      ...Object.entries(GENERATED).map(([name, source]) => ({
        file: `src/${name}`,
        source,
      })),
    ];
    const expected = jobs.map(compiled);
    const ported = jobs.map(
      (job) => analyze({ ...job, compiler: true }).compiler ?? [],
    );
    for (const [n, job] of jobs.entries()) {
      expect({ file: job.file, warnings: ported[n] }).toEqual({
        file: job.file,
        warnings: expected[n],
      });
    }
    // The set reaches the codes it's for.
    const codes = new Set(expected.flat().map((w) => w.code));
    for (const code of [
      "css_unused_selector",
      "block_empty",
      "state_referenced_locally",
      "element_invalid_self_closing_tag",
      "export_let_unused",
      "non_reactive_update",
      "event_directive_deprecated",
    ]) {
      expect(codes).toContain(code);
    }
  });

  it("lints a component whose CSS doesn't parse, as Svelte has no warnings for it", () => {
    const analysis = analyze({
      file: "src/Scss.svelte",
      source: GENERATED["Scss.svelte"] ?? "",
      compiler: true,
    });
    expect(analysis.syntax).toBeUndefined();
    expect(analysis.module).toBeDefined();
    expect(analysis.compiler).toEqual([]);
  });

  it("leaves the compiler's warnings out unless asked", () => {
    const source = GENERATED["Unused.svelte"] ?? "";
    expect(analyze({ file: "src/A.svelte", source }).compiler).toBeUndefined();
  });
});
