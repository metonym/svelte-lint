import { analyze } from "../src/analyze.ts";
import type { Diagnostic } from "../src/diagnostic.ts";
import { emit, toSource } from "../src/emit.ts";
import { isSvelteIdiom, moduleFor } from "../src/script-rules.ts";
import { lintTemplate } from "../src/template-rules.ts";

const at = (source: string, text: string, from = 0) =>
  source.indexOf(text, from);

function diagnostic(
  source: string,
  rule: string,
  text: string,
  from = 0,
): Diagnostic {
  const start = at(source, text, from);
  return {
    file: "A.svelte",
    rule,
    severity: "error",
    message: "",
    start,
    end: start + text.length,
  };
}

const idiom = (source: string, d: Diagnostic) => {
  const { module } = analyze({ file: "A.svelte", source });
  if (!module) throw new Error("A syntax error");
  return isSvelteIdiom({ file: "A.svelte", source, module }, d);
};

describe("emit", () => {
  it("keeps script offsets and maps markup expressions back", () => {
    const source = `<script lang="ts">\n  let count: number = 0;\n</script>\n\n<button on:click={() => (count += 1)}>{count}</button>\n`;
    const emitted = emit(source);
    expect(emitted.typescript).toBe(true);
    expect(
      emitted.code.slice(0, source.length).trimEnd().endsWith("</script>"),
    ).toBe(false);
    const inScript = at(source, "count:");
    expect(emitted.code.slice(inScript, inScript + 5)).toBe("count");
    const handler = at(emitted.code, "() => (count += 1)");
    expect(toSource(emitted, handler)).toBe(at(source, "() => (count += 1)"));
    // A blanked `<button>` isn't linted.
    expect(toSource(emitted, at(source, "<button"))).toBeNull();
  });

  it("declares what the markup scopes, so an each item isn't a global", () => {
    const emitted = emit(
      `<script>export let items = [];</script>\n{#each items as item}{item.name}{/each}`,
    );
    expect(emitted.code).toContain("__svelte((item) => (item.name));");
    expect(emitted.code).toContain("items = items;");
  });
});

describe("isSvelteIdiom", () => {
  const legacy = `<script>\n  let items = [];\n  function add() { items.push(1); items = items; }\n  $: total = items.length;\n  function f() { $: x = 1; }\n</script>`;

  it("allows `x = x` on a legacy component's top-level variable", () => {
    expect(
      idiom(
        legacy,
        diagnostic(
          legacy,
          "no-self-assign",
          "items",
          at(legacy, "= items") + 2,
        ),
      ),
    ).toBe(true);
    const runes = `<script>\n  let items = $state([]);\n  function add() { items = items; }\n</script>`;
    expect(
      idiom(
        runes,
        diagnostic(runes, "no-self-assign", "items", at(runes, "= items") + 2),
      ),
    ).toBe(false);
  });

  it("allows a top-level `$:` but not one inside a function", () => {
    expect(idiom(legacy, diagnostic(legacy, "no-unused-labels", "$"))).toBe(
      true,
    );
    expect(
      idiom(
        legacy,
        diagnostic(legacy, "no-unused-labels", "$", at(legacy, "function f")),
      ),
    ).toBe(false);
  });

  it("allows `export let x = undefined`, a prop, but not another `= undefined`", () => {
    const source = `<script>\n  export let size = undefined;\n  let other = undefined;\n</script>`;
    expect(idiom(source, diagnostic(source, "no-undef-init", "size"))).toBe(
      true,
    );
    expect(idiom(source, diagnostic(source, "no-undef-init", "other"))).toBe(
      false,
    );
  });

  it("allows `let` for props from $props()", () => {
    const source = `<script>\n  let { a } = $props();\n  let b = 1;\n</script>{a}{b}`;
    expect(idiom(source, diagnostic(source, "prefer-const", "a"))).toBe(true);
    expect(idiom(source, diagnostic(source, "prefer-const", "b"))).toBe(false);
  });
});

describe("moduleFor", () => {
  it("finds a module from bun lint's path, with either separator", () => {
    const byModule = new Map([
      ["src/A.svelte.ts", "src/A"],
      ["A.svelte.ts", "A"],
    ]);
    expect(
      moduleFor(byModule, "C:\\Users\\RUNNER~1\\Temp\\x\\src\\A.svelte.ts"),
    ).toBe("src/A");
    expect(moduleFor(byModule, "/private/var/x/A.svelte.ts")).toBe("A");
    expect(moduleFor(byModule, "/private/var/x/B.svelte.ts")).toBeUndefined();
  });
});

describe("lintTemplate", () => {
  const lint = (source: string, rule: string) =>
    lintTemplate("A.svelte", source, emit(source), { [rule]: "error" });

  it("fixes bind:value on a checkbox to bind:checked", () => {
    const source = `<script>let on = false;</script><input type="checkbox" bind:value={on} />`;
    const [d] = lint(source, "svelte/no-bind-value-on-checkable-inputs");
    expect(
      d.fix &&
        source.slice(0, d.fix.start) + d.fix.text + source.slice(d.fix.end),
    ).toContain("bind:checked={on}");
  });

  it("requires a key only for an each block with an item", () => {
    expect(
      lint("{#each [1] as n}{n}{/each}", "svelte/require-each-key"),
    ).toHaveLength(1);
    expect(
      lint("{#each [1] as n (n)}{n}{/each}", "svelte/require-each-key"),
    ).toHaveLength(0);
  });
});

describe("analyze", () => {
  it("gives the compiler's a11y warnings, minus what a Svelte 4 svelte-ignore silences", () => {
    const source =
      '<img src="a.png" />\n<!-- svelte-ignore a11y-missing-attribute -->\n<img src="b.png" />';
    expect(
      analyze({ file: "A.svelte", source }).a11y.map((w) => [w.code, w.start]),
    ).toEqual([["a11y_missing_attribute", 0]]);
  });
});
