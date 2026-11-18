# Changelog

## Unreleased

**Breaking**

- `svelte/compiler` is on, as `warn`, so a project gets the compiler's
  warnings, such as `css_unused_selector` and
  `state_referenced_locally`, without configuring it. Set it to `off`
  to go back.
- The compiler's warnings are Svelte 5's, from sveast 0.11.1's port,
  whichever Svelte the project has: svelte-lint no longer compiles, or
  loads the project's `svelte` at all, and no longer has a peer
  dependency on it. A Svelte 3 or 4 component gets the warnings Svelte
  5 gives it in legacy mode.

**Performance**

- With no compile, `svelte/compiler` costs about 70 ms of a 0.7s cold
  run on carbon-components-svelte's 2,207 components, where it took
  about 1s of 1.76s (#16, #10).

**Fixes**

- sveast 0.11.1 parses a snippet type parameter with an arrow function
  type, and an optional property in a template type annotation, which
  were syntax errors.
- Rules that resolve imports, such as `import/no-unresolved` and
  `import/no-cycle`, see the project from a component: its other files,
  its packages, and the components no run has linted yet. Before, a
  component's imports resolved only to other components' modules.
  `import/no-unresolved` reported thousands of false errors in a large
  project, and `import/no-cycle` missed a cycle through a `.js` file.
- A deleted component's module is removed, so `import/no-cycle` no
  longer reports a cycle through it.
- A component with a problem from an `import/` rule is linted every
  run, so the problem goes away once another file fixes it. Before,
  the cache kept it until the component changed.

## 0.1.3 — 2026-11-18

**Fixes**

- `--max-warnings` takes a whole number of 0 or more and exits 2 on
  anything else. `abc` was read as no limit.
- `--staged` with `--changed` exits 2. `--staged` won without a word.
- `--watch` skips a new component git ignores, such as one a build
  writes to `dist/`, as the first run does.
- `[lint]`'s `ignorePatterns` skip components too, matched as `bun lint`
  matches them. Only `[svelte-lint]`'s did, so a folder `bun lint`
  skipped still had its components linted.
- A path named on the command line is no longer skipped without a
  word (#2). As in `bun lint`, a named path that git ignores, or in a
  dot folder, is linted; a named file that `ignorePatterns` skip, or
  that isn't a `.svelte` file, is skipped with a warning; and a path
  that doesn't exist, or a folder with no component to lint, exits 2.
  The API's `lint` throws for those, and its result lists the skipped
  files in `skipped`.

**Docs**

- `docs/biome.md` maps a `biome.json` to `bunfig.toml`, rule by rule.
- The README says that svelte-check and svelte-typecheck report the
  compiler's warnings too, so `svelte/compiler` can stay off when CI
  runs either.

## 0.1.2 — 2026-11-12

**Fixes**

- `--format` defaults to `agent` under Codex (`CODEX_CI` or
  `CODEX_THREAD_ID`) and when `AGENT` is set, which `bun lint` reads.
  A variable set to `0` or to nothing no longer counts, as in
  `bun lint`. The docs said the default matched `bun lint`, but
  `bun lint` ignores `AI_AGENT`, which is still read.

## 0.1.1 — 2026-11-06

**Fixes**

- A compiler warning in `<style>`, such as `css_unused_selector`, said to
  add `<!-- svelte-ignore -->` above it, which Svelte doesn't read inside
  `<style>`; it now says above the `<style>` tag.
- `css_unused_selector` says that a class or attribute the script sets
  needs `:global(...)`, the usual cause: Svelte drops the rule otherwise.

## 0.1.0 — 2026-11-04

The first release of svelte-lint, the Svelte linter extracted from
carbon-components-svelte's `scripts/svelte-lint.ts`.

**Features**

- `bun lint`'s `[lint]` rules in components' scripts and markup
  expressions, with their overrides, `eslint-disable` comments and fixes,
  and Svelte's idioms left out: `x = x` on a legacy component's
  top-level variable, a top-level `$:`, `export let x = undefined`, and
  `let` for `$props()` and `$derived`.
- Template rules for the markup, in `[svelte-lint]`: keyed `{#each}`,
  `bind:value` on a checkbox or radio, `<button>` without a type, and
  `aria-hidden` on a focusable element.
- The Svelte compiler's a11y warnings without compiling, from
  `sveast/a11y`, with `svelte-ignore` as Svelte reads it in Svelte 3, 4
  and 5; the compiler's other warnings with `svelte/compiler`.
- A cache by content in `node_modules/.cache/svelte-lint`, `--fix`,
  `--staged`, `--changed`, `--watch`, and `pretty`, `agent`, `json` and
  `github` output.
- No dependencies: sveast is bundled, and Svelte is an optional peer.
  It needs a Bun with `bun lint`: 1.4.5, or a canary build.
