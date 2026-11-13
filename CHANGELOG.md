# Changelog

## Unreleased

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
