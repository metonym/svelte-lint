import { existsSync } from "node:fs";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
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

  it("lints a named path git ignores, as bun lint does", async () => {
    const dir = await workspace("named-ignored");
    await writeFile(join(dir, ".gitignore"), "scratch/\n");
    await mkdir(join(dir, "scratch/deep"), { recursive: true });
    await mkdir(join(dir, ".context"));
    const button = "<button>x</button>\n";
    await writeFile(join(dir, "scratch/A.svelte"), button);
    await writeFile(join(dir, "scratch/deep/B.svelte"), button);
    await writeFile(join(dir, ".context/C.svelte"), button);
    // Not unless named.
    expect((await lint({ cwd: dir, cache: false })).files).not.toContain(
      "scratch/A.svelte",
    );
    for (const [paths, files] of [
      [["scratch/A.svelte"], ["scratch/A.svelte"]],
      [["scratch"], ["scratch/A.svelte", "scratch/deep/B.svelte"]],
      [["scratch/deep"], ["scratch/deep/B.svelte"]],
      [[".context"], [".context/C.svelte"]],
    ]) {
      // One at a time: runs in one process share the folder of modules.
      // eslint-disable-next-line no-await-in-loop
      const result = await lint({ cwd: dir, paths, cache: false });
      expect(result.files.toSorted()).toEqual(files);
      expect(result.errors).toBe(files.length);
    }
  });

  it("says which named files it skips, and throws for a path with nothing to lint", async () => {
    const result = await lint({
      cwd: FIXTURES,
      paths: ["src/Ignored.svelte", "bunfig.toml", "src/Clean.svelte"],
      cache: false,
    });
    expect(result.files).toEqual(["src/Clean.svelte"]);
    expect(result.skipped).toEqual([
      { path: "src/Ignored.svelte", reason: "ignored" },
      { path: "bunfig.toml", reason: "not a component" },
    ]);
    const dir = await workspace("named-nothing");
    await mkdir(join(dir, "empty"));
    await mkdir(join(dir, "skipped"));
    await writeFile(join(dir, "skipped/S.svelte"), "<p>s</p>\n");
    await writeFile(
      join(dir, "bunfig.toml"),
      `${await readFile(join(dir, "bunfig.toml"), "utf8")}`.replace(
        `ignorePatterns = ["src/Ignored.svelte"]`,
        `ignorePatterns = ["src/Ignored.svelte", "skipped/**"]`,
      ),
    );
    await Promise.all(
      [
        ["does/not/exist.svelte", "no such file or folder"],
        ["empty", "has no components"],
        ["skipped", "skip every component"],
        ["..", "outside the project"],
      ].map(([path, message]) =>
        expect(lint({ cwd: dir, paths: [path], cache: false })).rejects.toThrow(
          message,
        ),
      ),
    );
    // --staged and --changed may pick nothing under a path.
    expect(
      (await lint({ cwd: dir, paths: ["empty"], staged: true })).files,
    ).toEqual([]);
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
