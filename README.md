# svelte-lint

> The Svelte linter for `bun lint`: your `[lint]` rules inside components, plus template and compiler a11y checks. Zero dependencies, cached, with a watch mode.

`bun lint` lints JavaScript and TypeScript natively, but not `.svelte` files. svelte-lint turns each component into a module `bun lint` can read, runs it with the rules already in your `bunfig.toml`, and maps every problem and fix back to its line and column in the component. It also checks the markup with its own rules and the Svelte compiler's a11y checks, and caches every component's result, so a run lints only what changed.

```sh
bun add -d svelte-lint
bunx svelte-lint
```

```
12 | <img src="a.png" />
     ^^^^^^^^^^^^^^^^^^^
error: `<img>` element should have an alt attribute  svelte/a11y_missing_attribute
    at src/Problems.svelte:12:1

note: Fix it, or add <!-- svelte-ignore a11y_missing_attribute --> above it.

13 | <button>{[count].forEach((c) => c)}</button>
              ^^^^^^^^^^^^^^^^^^^^^^^^^^
error: Use a for...of loop instead of forEach.  no-restricted-syntax
    at src/Problems.svelte:13:10

2 problems (2 errors, 0 warnings)
Linted 1 file [61.07ms]
```

It needs a Bun with `bun lint`: 1.4.5, or a canary build until it ships.

## Why

|                    | Biome                         | ESLint + eslint-plugin-svelte | svelte-lint                                          |
| :----------------- | :---------------------------- | :---------------------------- | :--------------------------------------------------- |
| Script rules       | Biome's, in a second config   | ESLint's                      | `bun lint`'s, from your `[lint]`                     |
| Markup expressions | Biome's rules                 | Some                          | Every `[lint]` rule, fixes included                  |
| a11y               | 15 HTML rules                 | The compiler's, by compiling  | The compiler's 42, without compiling                 |
| Svelte's idioms    | Overrides that turn rules off | Svelte-aware rules            | The rules stay on, minus what Svelte does on purpose |
| Svelte 3, 4, 5     | Yes                           | Yes                           | Yes, and their `svelte-ignore` codes                 |
| Cache              | No                            | Opt-in                        | Every run, by content                                |

On carbon-components-svelte's 2,207 components, on an M-series Mac at load average 5 to 8, against Biome 2.6's `.svelte` linting:

| Run                        | Biome         | svelte-lint                           |
| :------------------------- | :------------ | :------------------------------------ |
| Every component, cold      | 1.44s, 422 MB | 1.04s, 191 MB                         |
| Nothing changed            | 1.44s, 422 MB | 0.06s, 32 MB                          |
| One component changed      | 1.44s, 422 MB | 0.11s, 55 MB                          |
| One component (`--staged`) | 0.35s, 351 MB | 0.06s, 32 MB                          |
| `--watch`, one save        |               | 45ms to the first output, 70ms in all |

ESLint with eslint-plugin-svelte took about 21s for the same components, cold.

## Usage

```sh
svelte-lint                      # every component git knows of
svelte-lint src/lib              # the components under a path
svelte-lint --fix                # apply the fixes, then lint again
svelte-lint --staged --fix       # in a pre-commit hook
svelte-lint --changed            # what differs from the default branch
svelte-lint --watch              # again on each save
```

| Option                  | Description                                                                                                                                |
| :---------------------- | :----------------------------------------------------------------------------------------------------------------------------------------- |
| `--fix`                 | Apply the fixes, then lint the fixed components again, up to 10 times                                                                      |
| `--staged`              | Only the components staged in git                                                                                                          |
| `--changed[=<ref>]`     | Only the components that differ from `<ref>`, committed or not (default: the default branch)                                               |
| `--watch`               | Lint again each time a component or `bunfig.toml` changes                                                                                  |
| `--format <name>`       | `pretty`, `agent`, `json` (ESLint's) or `github` (annotations). Default: `agent` for a coding agent, as `bun lint` picks it, else `pretty` |
| `--max-warnings <n>`    | Exit 1 on more warnings than this. Default: `[lint]`'s `maxWarnings`                                                                       |
| `--no-cache`            | Lint every component, and keep no cache                                                                                                    |
| `--color`, `--no-color` | Force color on or off                                                                                                                      |

It exits 1 on an error, or on more warnings than `--max-warnings`, and 2 on a bad option. The project is the nearest folder with a `bunfig.toml`, from the current one up, as `bun lint` finds its config. Its components are the `.svelte` files git tracks or would add, or outside a repository, every one but those in `node_modules` and dot folders.

## Configuration

Everything lives in `bunfig.toml`. `[lint]` is `bun lint`'s, and lints the components' scripts and markup expressions as it lints your `.ts` files: the same rules, overrides and `// eslint-disable` comments. An override for `src/**/*.svelte` applies to components; `src/**` applies to them and to the `.ts` files.

`[svelte-lint]` has the rules for the markup, which `bun lint` doesn't know:

```toml
[svelte-lint]
ignorePatterns = ["src/legacy/**"]
rules = { "svelte/require-each-key" = "off" }

[[svelte-lint.overrides]]
files = ["src/**/*.svelte"]
rules = { "svelte/require-each-key" = "error" }
```

| Rule                                       | Default | Reports                                                                                                    |
| :----------------------------------------- | :------ | :--------------------------------------------------------------------------------------------------------- |
| `svelte/require-each-key`                  | error   | An `{#each}` with an item and no key                                                                       |
| `svelte/no-bind-value-on-checkable-inputs` | error   | `bind:value` on a checkbox or a radio; fixes a checkbox's to `bind:checked`                                |
| `svelte/button-has-type`                   | error   | A `<button>` without a `type`, which submits a form it's in                                                |
| `svelte/no-aria-hidden-on-focusable`       | error   | `aria-hidden="true"` on an element the keyboard can still reach                                            |
| `svelte/a11y`                              | error   | The Svelte compiler's a11y warnings, from [sveast](https://github.com/metonym/sveast)'s port of its checks |
| `svelte/compiler`                          | off     | The compiler's other warnings, from the project's own `svelte`, by compiling                               |

A severity is `"error"`, `"warn"` or `"off"`. `<!-- svelte-ignore code -->` silences a compiler warning as it does in Svelte: in legacy mode, Svelte 4's `a11y-…` codes count too. A syntax error is always reported.

### Svelte's idioms

The script rules stay on in components, and svelte-lint drops only the reports for what Svelte does on purpose, so the same code anywhere else is still reported:

| Rule               | Allowed                                                                                   |
| :----------------- | :---------------------------------------------------------------------------------------- |
| `no-self-assign`   | `items = items` on a legacy component's top-level variable, which tells Svelte it changed |
| `no-unused-labels` | A top-level `$:`, a reactive statement                                                    |
| `no-undef-init`    | `export let size = undefined`, an optional prop                                           |
| `prefer-const`     | `let` for props from `$props()` and for `$derived`                                        |
| `no-unused-vars`   | `$$Props`, `$$Events` and `$$Slots`                                                       |

What the markup reads and writes counts too: a variable `bind:` writes isn't `prefer-const`, and an import only the markup uses isn't unused.

## API

```ts
import { lint, watch } from "svelte-lint";

const { diagnostics, errors } = await lint({ cwd: "/my-app", paths: ["src"] });

const watcher = await watch({
  cwd: "/my-app",
  onUpdate: ({ stage, diagnostics }) => {},
});
watcher.close();
```

`lint` takes the CLI's options (`cwd`, `paths`, `staged`, `changed`, `fix`, `cache`) and returns each problem with its file, rule, severity, message, lines and columns, offsets and fix. `watch` calls `onUpdate` with every watched component's problems: first with the template and a11y problems of what changed, then with `bun lint`'s.

## How it works

Each component becomes a module at the same offsets: its `<script>`s as they are, the markup blanked to spaces with its line breaks kept, and the markup's expressions after them. A part `bun lint` doesn't lint, in `eslint-disable` comments, says what the markup and Svelte do to the scripts' names: which ones the markup reads and writes, that a parent writes the props, that `$count` reads `count`, and the names Svelte declares. `bun lint` lints the modules in a temporary folder with your `[lint]`, and each problem and fix maps back to the component. The template rules and a11y checks run on the same parse, by [sveast](https://github.com/metonym/sveast), which is bundled, so the package has no dependencies.

A component whose size and modification time haven't changed since the last run isn't read; one whose content hasn't changed isn't parsed or linted. Results are kept in `node_modules/.cache/svelte-lint`, keyed by svelte-lint's version, `bunfig.toml`, Bun and the project's Svelte. In CI, restore that folder between runs.

## Limitations

- A component that parses but fails the compiler's analysis, such as one with an invalid attribute name, isn't reported. Your build reports it.
- Each run, and each change in `--watch`, starts a `bun lint` process, which is most of the time a small change takes.
- `svelte/a11y` follows Svelte 5's checks, whichever Svelte the project has.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
