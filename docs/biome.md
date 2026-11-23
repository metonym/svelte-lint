# Moving from Biome

Biome lints and formats `.svelte` files in one tool.
Without it, `bun fmt` formats them, `bun lint` lints your `.ts`
and `.js` files, and svelte-lint lints the components with the same
`[lint]` rules.
This page maps a `biome.json` to `bunfig.toml`.
It comes from moving carbon-preprocess-svelte
and svelte-time off Biome 2.

```diff
- "lint": "biome check --write .",
+ "lint:all": "bun fmt && bun lint --fix && svelte-lint --fix",
+ "lint:svelte": "svelte-lint",
```

Don't call the script `lint`: on a Bun without `bun lint`,
`bun lint` runs the `lint` script, which would then call itself.
In CI, `biome ci` becomes `bun fmt --check`,
`bun lint` and `svelte-lint`, which write nothing.

## Config

| `biome.json`                                                          | `bunfig.toml`                                                                                                      |
| :-------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------- |
| `linter.rules`                                                        | `[lint.rules]`, under the ESLint names below. ESLint's and typescript-eslint's recommended rules are on by default |
| `overrides` with `linter.rules`                                       | `[[lint.overrides]]` with `files` and `rules`. svelte-lint applies them to the components they match               |
| `files.includes` negations, or an override's `linter.enabled = false` | `[lint]`'s `ignorePatterns`, which svelte-lint skips too                                                           |
| `--error-on-warnings`                                                 | `maxWarnings = 0` in `[lint]`                                                                                      |
| `formatter`, `html.formatter`                                         | `[fmt]`. `bun fmt` formats `.svelte` files unless the project has a Prettier or oxfmt config                       |
| `markdown.formatter.enabled = false`                                  | `ignorePatterns = ["**/*.md"]` in `[fmt]`                                                                          |

`bun fmt` moves a component's `<script>` to the top
and its `<style>` to the bottom.
Biome keeps them where they are, and so does this:

```toml
[fmt.svelte]
sortOrder = "none"
```

## Rules

| Biome                          | `bun lint`                                                                               |
| :----------------------------- | :--------------------------------------------------------------------------------------- |
| `noAccumulatingSpread`         | `oxc/no-accumulating-spread`                                                             |
| `noAwaitInLoops`               | `no-await-in-loop`                                                                       |
| `noCommaOperator`              | `no-sequences`, with `{ allowInParentheses = false }` to catch `(a, b)` as well          |
| `noCommonJs`                   | `import/no-commonjs`                                                                     |
| `noExplicitAny`                | `@typescript-eslint/no-explicit-any`                                                     |
| `noFocusedTests`               | `jest/no-focused-tests`                                                                  |
| `noForEach`                    | `unicorn/no-array-for-each`                                                              |
| `noImportCycles`               | `import/no-cycle`                                                                        |
| `noNegationElse`               | `no-negated-condition`                                                                   |
| `noParameterAssign`            | `no-param-reassign`                                                                      |
| `noRestrictedGlobals`          | `no-restricted-globals`. Biome always disallows `event` and `error`: list them           |
| `noRestrictedImports`          | `no-restricted-imports`                                                                  |
| `noSkippedTests`               | `jest/no-disabled-tests`                                                                 |
| `noTsIgnore`                   | `@typescript-eslint/ban-ts-comment`, with `{ "ts-expect-error" = false }`                |
| `noUselessConstructor`         | `no-useless-constructor`                                                                 |
| `noUselessEmptyExport`         | `@typescript-eslint/no-useless-empty-export`                                             |
| `noUselessLabel`               | `no-extra-label`                                                                         |
| `noUselessLoneBlockStatements` | `no-lone-blocks`                                                                         |
| `noUselessRename`              | `no-useless-rename`                                                                      |
| `noUselessSwitchCase`          | `unicorn/no-useless-switch-case`                                                         |
| `noUselessTypeConstraint`      | `@typescript-eslint/no-unnecessary-type-constraint`                                      |
| `useArrowFunction`             | `prefer-arrow-callback`                                                                  |
| `useConst`                     | `prefer-const`                                                                           |
| `useDefaultParameterLast`      | `@typescript-eslint/default-param-last`                                                  |
| `useExponentiationOperator`    | `prefer-exponentiation-operator`                                                         |
| `useExportType`                | `@typescript-eslint/consistent-type-exports`                                             |
| `useImportType`                | `@typescript-eslint/consistent-type-imports`, with `{ disallowTypeAnnotations = false }` |
| `useLiteralKeys`               | `dot-notation`                                                                           |
| `useNodejsImportProtocol`      | `unicorn/prefer-node-protocol`                                                           |
| `useNumberNamespace`           | `unicorn/prefer-number-properties`                                                       |
| `useSingleVarDeclarator`       | `one-var`, with `"never"`                                                                |

`bun lint` has no rule for `noDelete`, `noEnum`, `noNamespaceImport`,
`noReExportAll`, `noUnusedTemplateLiteral` or `useTopLevelRegex`.
These `no-restricted-syntax` selectors report the same code:

```toml
"no-restricted-syntax" = [
  "error",
  # noDelete
  { selector = "UnaryExpression[operator='delete'] > MemberExpression[computed=false]", message = "Avoid the delete operator; assign undefined or rebuild the object." },
  # noEnum
  { selector = "TSEnumDeclaration", message = "Use a union of literals or a const object instead of an enum." },
  # noNamespaceImport
  { selector = "ImportDeclaration[importKind!='type'] > ImportNamespaceSpecifier", message = "Import names explicitly instead of a namespace." },
  # noReExportAll
  { selector = "ExportAllDeclaration", message = "Export names explicitly instead of re-exporting everything." },
  # noUnusedTemplateLiteral: a template with no interpolation, quote or line break
  { selector = ":not(TaggedTemplateExpression) > TemplateLiteral[expressions.length=0]:not([quasis.0.value.raw=/['\"\\n]/])", message = "Use a string literal for a template without interpolation." },
  # useTopLevelRegex: a regex literal in a function, unless it has the g or y flag
  { selector = ":function Literal[regex]:not([regex.flags=/[gy]/])", message = "Hoist the regular expression to the top level so it compiles once." },
]
```

An override's `no-restricted-syntax` replaces this list,
it doesn't add to it.
To turn one selector off for the tests,
repeat the others in the override.

A few rules have nothing to map to:

- `noDynamicNamespaceImportAccess`: no rule,
  but banning namespace imports covers most of it.
- `noImportantStyles`: `bun lint` doesn't read CSS.
- `noUselessFragments`, `noImplicitBoolean` and the other JSX rules:
  a component has no JSX.
