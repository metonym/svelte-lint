# Contributing

## Setup

[Bun](https://bun.sh/) is the runtime, package manager, test runner and bundler, and `bun lint` does the script rules, so use a Bun that has it: 1.4.5, or `bun upgrade --canary` until it ships.

```sh
bun ci
bun run test          # unit and end-to-end tests
bun run test:package  # build, pack, install, and lint a project as a user would
bun run typecheck
bun run lint          # bun fmt --check and bun lint
bun run knip
bun run build         # dist/: the bundle, index.d.ts and a slimmed package.json
```

## How it works

1. **Finding the components** (`src/files.ts`, `src/api.ts`). The project root is the nearest folder with a `bunfig.toml` from `cwd` up (`findRoot` in `src/config.ts`). git lists the components: tracked and untracked but not ignored, staged, or changed from a ref, with `--relative` so the paths are the root's. Outside a repository, `src/glob.ts` walks the folder. `[svelte-lint]`'s `ignorePatterns` drop some.
2. **The cache** (`src/lint.ts`, `src/cache.ts`). A component whose size and modification time match the cache isn't read. One whose content hash matches isn't parsed. The cache's key is svelte-lint's version and code, `bunfig.toml`, `Bun.revision` and the project's Svelte version: any change empties it.
3. **Analysis** (`src/analyze.ts`, `src/emit.ts`, `src/template-rules.ts`). sveast parses each component once. `emit` writes its module: the scripts at their offsets, the markup blanked, a part in `eslint-disable` comments with the markup's reads and writes, the props' writes, store reads and the names Svelte declares, and then each markup expression, wrapped in a function whose parameters are the names the markup declares there (an each block's item, a snippet's parameters). `facts` keeps the offsets the Svelte-aware filters need, so the AST can go. The template rules and `sveast/a11y` run on the same AST.
4. **`bun lint`** (`src/script-rules.ts`). The modules go to a temporary folder outside the project, so its `.gitignore` doesn't hide them, beside a `bunfig.toml` that is the project's `[lint]` with its override globs widened from `*.svelte` to the modules' `*.svelte.js` and `*.svelte.ts` (`moduleBunfig` in `src/config.ts`). Components are analyzed in batches, and each batch is linted while the next is analyzed. `toDiagnostic` maps each problem and fix back to the component; `isSvelteIdiom` drops the reports for what Svelte does on purpose.
5. **Fixes** (`lintAndFix` in `src/lint.ts`) apply each component's non-overlapping fixes from the end, then lint the fixed components again, as ESLint does, up to 10 times.
6. **Watch** (`src/watch.ts`) keeps the session, the config and the cache, in memory, and lints what a recursive `fs.watch` reports, after a 20ms debounce. The template problems report first, with `bun lint`'s from before the change kept until its new ones are in.

## Rules every change must keep

- **The script rules are the project's `[lint]`.** svelte-lint doesn't add or change script rules; it makes the module's code mean what the component means, and drops only the reports `isSvelteIdiom` lists.
- **A problem points at the component.** Lines, columns and fixes map back to the `.svelte` file; a problem in the generated part is dropped, never reported.
- **No runtime dependencies.** sveast is bundled; Svelte, for `svelte/compiler`, is loaded from the project.
- **Load only what a run needs.** The parser and the compiler load only when a component changed, and git starts before the rest loads.

## Tests

| File                      | Covers                                                                                                                                                            |
| :------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/rules.test.ts`     | `emit`'s offsets and markup scopes, `isSvelteIdiom`, the template rules and the a11y checks                                                                       |
| `tests/lint.test.ts`      | `lint` on `tests/fixtures`: each rule, Svelte's idioms, ignored components, positions, the root from a subfolder, paths, `fix`, the cache, `staged` and `changed` |
| `tests/watch.test.ts`     | `watch`: a new component's template problems first, then `bun lint`'s, and a removed one                                                                          |
| `tests/cli.test.ts`       | The CLI's formats and exit codes                                                                                                                                  |
| `tests/api.test.ts`       | The exports against `src/types.ts`, the package's `index.d.ts`                                                                                                    |
| `scripts/test-package.ts` | The packed package's imports, and its bin and API on a project                                                                                                    |

`tests/shared.ts`'s `workspace` copies the fixtures into `tests/.tmp`, in a git repository of their own, for the tests that change them.

## Releasing

Bump `version` in `package.json` and move `CHANGELOG.md`'s Unreleased notes under the version, in a commit named after it (`v0.1.0`), and tag it. The release workflow builds, tests the packed package and publishes on the tag.

## Before you finish

`bun run lint`, `bun run typecheck`, `bun run knip`, `bun run test` and `bun run test:package`.
