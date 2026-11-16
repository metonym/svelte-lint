import { existsSync } from "node:fs";
import { readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lint } from "../src/api.ts";
import { brief, FIXTURES, workspace } from "./shared.ts";

const PROBLEMS = [
  "src/Problems.svelte:2 no-restricted-imports",
  "src/Problems.svelte:3 no-var",
  "src/Problems.svelte:4 no-unused-vars",
  "src/Problems.svelte:4 prefer-const",
  "src/Problems.svelte:9 svelte/require-each-key",
  "src/Problems.svelte:12 svelte/a11y_missing_attribute",
  "src/Problems.svelte:13 svelte/button-has-type",
  "src/Problems.svelte:13 no-restricted-syntax",
  "src/Problems.svelte:14 svelte/no-bind-value-on-checkable-inputs",
  "src/Syntax.svelte:3 syntax",
];

describe("lint", () => {
  it("reports each rule's problems, and none for Svelte's idioms or ignored components", async () => {
    const result = await lint({ cwd: FIXTURES, cache: false });
    expect(result.root).toBe(FIXTURES);
    expect(result.files.sort()).toEqual([
      "src/Clean.svelte",
      "src/Legacy.svelte",
      "src/Problems.svelte",
      "src/Syntax.svelte",
    ]);
    expect(result.diagnostics.map(brief)).toEqual(PROBLEMS);
    expect([result.errors, result.warnings]).toEqual([10, 0]);
  });

  it("places a problem on its line and column, and in the source's offsets", async () => {
    const { diagnostics } = await lint({ cwd: FIXTURES, cache: false });
    const img = diagnostics.find(
      (d) => d.rule === "svelte/a11y_missing_attribute",
    );
    expect(img).toMatchObject({
      line: 12,
      column: 1,
      endLine: 12,
      endColumn: 20,
    });
    const source = await readFile(
      join(FIXTURES, "src/Problems.svelte"),
      "utf8",
    );
    expect(img && source.slice(img.start, img.end)).toBe('<img src="a.png" />');
  });

  it("finds the project from a folder inside it, and lints only the paths given", async () => {
    const result = await lint({
      cwd: join(FIXTURES, "src"),
      paths: ["Legacy.svelte"],
      cache: false,
    });
    expect(result.root).toBe(FIXTURES);
    expect(result.files).toEqual(["src/Legacy.svelte"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("fixes what it can, and leaves the rest", async () => {
    const dir = await workspace("fix");
    const { diagnostics } = await lint({ cwd: dir, fix: true, cache: false });
    const fixed = await readFile(join(dir, "src/Problems.svelte"), "utf8");
    expect(fixed).toContain("const count = 1;");
    expect(fixed).toContain("const unused = 2;");
    expect(fixed).toContain("bind:checked={checked}");
    expect(diagnostics.map((d) => d.rule)).not.toContain("no-var");
    expect(diagnostics.map((d) => d.rule)).toContain(
      "svelte/a11y_missing_attribute",
    );
  });

  it("caches problems by content: a touched file is the same, an edited one is linted again", async () => {
    const dir = await workspace("cache");
    const first = await lint({ cwd: dir });
    expect(
      existsSync(join(dir, "node_modules/.cache/svelte-lint/results.json")),
    ).toBe(true);
    // A checkout that leaves the content as it was.
    const legacy = join(dir, "src/Legacy.svelte");
    await utimes(legacy, new Date(), new Date(Date.now() + 5000));
    expect((await lint({ cwd: dir })).diagnostics).toEqual(first.diagnostics);
    await writeFile(
      legacy,
      `${await readFile(legacy, "utf8")}<img src="b.png" />\n`,
    );
    const edited = await lint({ cwd: dir });
    expect(edited.diagnostics.map(brief)).toContain(
      "src/Legacy.svelte:19 svelte/a11y_missing_attribute",
    );
  });

  it("lints the staged components, or the ones changed from a ref", async () => {
    const dir = await workspace("changed");
    expect(
      (await lint({ cwd: dir, staged: true, cache: false })).files,
    ).toEqual([]);
    expect(
      (await lint({ cwd: dir, changed: true, cache: false })).files,
    ).toEqual([]);
    await writeFile(join(dir, "src/New.svelte"), "<img src='c.png' />\n");
    expect(
      (await lint({ cwd: dir, changed: true, cache: false })).files,
    ).toEqual(["src/New.svelte"]);
    Bun.spawnSync(["git", "add", "src/New.svelte"], { cwd: dir });
    const staged = await lint({ cwd: dir, staged: true, cache: false });
    expect(staged.diagnostics.map(brief)).toEqual([
      "src/New.svelte:1 svelte/a11y_missing_attribute",
    ]);
  });
});

describe("compiler warnings", () => {
  it("hints at :global for a scoped selector the script's attribute misses, and where to silence it", async () => {
    const dir = await workspace("compiler-help");
    await writeFile(
      join(dir, "src/Scoped.svelte"),
      `<script>
  let el;
  $: el?.toggleAttribute("data-open", true);
</script>

<div bind:this={el} class="item"></div>

<style>
  .item[data-open] {
    color: red;
  }
</style>
`,
    );
    await writeFile(
      join(dir, "bunfig.toml"),
      `${await readFile(join(dir, "bunfig.toml"), "utf8")}
[[svelte-lint.overrides]]
files = ["src/Scoped.svelte"]
rules = { "svelte/compiler" = "error" }
`,
    );
    const { diagnostics } = await lint({ cwd: dir, cache: false });
    const unused = diagnostics.find(
      (d) => d.rule === "svelte/css_unused_selector",
    );
    expect(unused?.help).toBe(
      "If the script sets the class or attribute, wrap that part in `:global(...)`, as in `.item:global([data-open])`. Otherwise fix it, or add <!-- svelte-ignore css_unused_selector --> above the `<style>` tag.",
    );
  });
});

describe("rules that read other files", () => {
  const IMPORT_RULES = `
[[lint.overrides]]
files = ["src/**"]
rules = { "import/no-cycle" = "error", "import/no-unresolved" = "error" }
`;

  it("resolves the project's files and packages from a component", async () => {
    const dir = await workspace("resolve");
    await writeFile(
      join(dir, "bunfig.toml"),
      `${await readFile(join(dir, "bunfig.toml"), "utf8")}${IMPORT_RULES}`,
    );
    await writeFile(join(dir, "src/util.js"), "export const x = 1;\n");
    await writeFile(
      join(dir, "src/Uses.svelte"),
      `<script>
  import { x } from "./util.js";
  import { onMount } from "svelte";
  import Clean from "./Clean.svelte";
  onMount(() => x);
</script>

<Clean />
`,
    );
    const { diagnostics } = await lint({
      cwd: dir,
      paths: ["src/Uses.svelte"],
      cache: false,
    });
    expect(diagnostics.map(brief)).toEqual([]);
  });

  it("finds a cycle through a module, and forgets it once the cycle is gone", async () => {
    const dir = await workspace("cycle");
    await writeFile(
      join(dir, "bunfig.toml"),
      `${await readFile(join(dir, "bunfig.toml"), "utf8")}${IMPORT_RULES}`,
    );
    const a = join(dir, "src/A.svelte");
    await writeFile(
      a,
      `<script>\n  import { b } from "./b.js";\n  b;\n</script>\n`,
    );
    await writeFile(
      join(dir, "src/b.js"),
      `import A from "./A.svelte";\nexport const b = A;\n`,
    );
    const paths = ["src/A.svelte"];
    expect((await lint({ cwd: dir, paths })).diagnostics.map(brief)).toEqual([
      "src/A.svelte:2 import/no-cycle",
    ]);
    // A is the same, but b.js no longer imports it.
    await writeFile(join(dir, "src/b.js"), "export const b = 1;\n");
    expect((await lint({ cwd: dir, paths })).diagnostics).toEqual([]);
  });

  it("forgets a deleted component's imports", async () => {
    const dir = await workspace("deleted");
    await writeFile(
      join(dir, "bunfig.toml"),
      `${await readFile(join(dir, "bunfig.toml"), "utf8")}${IMPORT_RULES}`,
    );
    const a = join(dir, "src/A.svelte");
    const b = join(dir, "src/B.svelte");
    await writeFile(
      a,
      `<script>\n  import B from "./B.svelte";\n</script>\n\n<B />\n`,
    );
    await writeFile(
      b,
      `<script>\n  import A from "./A.svelte";\n</script>\n\n<A />\n`,
    );
    expect(
      (await lint({ cwd: dir, cache: false })).diagnostics
        .map(brief)
        .filter((d) => d.includes("import/")),
    ).toEqual([
      "src/A.svelte:2 import/no-cycle",
      "src/B.svelte:2 import/no-cycle",
    ]);
    await rm(b);
    await writeFile(
      a,
      `<script>\n  import B from "./B.svelte";\n</script>\n\n<B />\n<p></p>\n`,
    );
    expect(
      (
        await lint({ cwd: dir, paths: ["src/A.svelte"], cache: false })
      ).diagnostics.map(brief),
    ).toEqual(["src/A.svelte:2 import/no-unresolved"]);
  });
});
