import { defineConfig } from "bivium";

const fixtures = "tests/fixtures/**";

export default defineConfig({
  suites: {
    unit: {
      tests: "tests/*.test.ts",
      run: "bun test {files}",
      root: "tests",
      // `bun test` runs the code: an `import type` or a declaration file
      // can't change what a test does.
      types: false,
    },
    package: {
      tests: "scripts/test-package.ts",
      root: "scripts/test-package.ts",
    },
  },
  roots: ["src", "tests", "scripts", "package.json", "tsconfig.json"],
  // Docs, and config for tools and workflows that run none of these suites.
  ignore: [
    "**/*.md",
    "LICENSE",
    ".gitignore",
    "knip.json",
    ".github/workflows/release.yml",
  ],
  // Inputs that aren't imports: the CLI a test runs as a user would, the
  // fixtures it lints or copies to a temp workspace.
  edges: {
    "tests/cli.test.ts": "src/cli.ts",
    // Builds and packs the package, then lints the fixtures with it.
    "scripts/test-package.ts": "scripts/build.ts",
    "scripts/build.ts": ["src/{index,cli}.ts", "src/types.ts", "package.json"],
  },
  reads: {
    "tests/shared.ts": fixtures,
    "tests/cli.test.ts": fixtures,
    "tests/lint.test.ts": fixtures,
    "tests/watch.test.ts": fixtures,
    "scripts/test-package.ts": fixtures,
  },
  // Tools CI runs on its own: a bump that only reaches them selects nothing.
  inert: ["knip"],
  // svelte-lint reads its user's project, and runs bun lint on it. The
  // package test imports the copy it installs in a temp folder.
  hermetic: ["src/**", "scripts/test-package.ts"],
});
