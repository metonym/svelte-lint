import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseImportsExports } from "sveast";
import { lexDynamicImports } from "sveast/lexer";

const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist");
const dir = mkdtempSync(join(tmpdir(), "svelte-lint-package-"));
const LOCAL_OR_BUILTIN = /^(node:|bun:|\.\/)/;
// Node's builtins, as the bundler writes them.
const BUILTINS = new Set([
  "path",
  "util",
  "fs",
  "os",
  "crypto",
  "child_process",
  "url",
  "module",
]);

function ok(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf-8" });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`,
    );
  return result.stdout;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

try {
  ok("bun", ["run", "build"], root);

  // The bundle imports Bun's and Node's builtins, its own chunks and
  // Svelte's compiler (the project's): no dependencies, sveast included.
  for (const file of await readdir(dist)) {
    if (!file.endsWith(".js")) continue;
    // A parser, not a regex: the bundled parser's strings look like imports.
    const text = readFileSync(join(dist, file), "utf-8");
    const statics = parseImportsExports(text, { localExports: false }).flatMap(
      (node) =>
        "source" in node && node.source ? [String(node.source.value)] : [],
    );
    const dynamics = lexDynamicImports(text).flatMap((call) =>
      call.source ? [call.source.value] : [],
    );
    for (const specifier of [...statics, ...dynamics]) {
      assert(
        LOCAL_OR_BUILTIN.test(specifier) ||
          BUILTINS.has(specifier) ||
          specifier === "bun" ||
          specifier === "svelte/compiler",
        `dist/${file} imports ${specifier}`,
      );
    }
  }
  const manifest = JSON.parse(
    readFileSync(join(dist, "package.json"), "utf-8"),
  );
  assert(!manifest.dependencies, "the package has dependencies");

  // Install the packed package into a project, as a user would.
  const tarball =
    ok("npm", ["pack", "--pack-destination", dir], dist)
      .trim()
      .split("\n")
      .at(-1) ?? "";
  const project = join(dir, "project");
  cpSync(join(root, "tests/fixtures"), project, { recursive: true });
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "project", private: true }),
  );
  ok("bun", ["add", "-d", join(dir, tarball)], project);
  ok("git", ["init", "-q"], project);

  const lint = spawnSync(
    "bun",
    ["x", "svelte-lint", "--format=json", "--no-cache"],
    { cwd: project, encoding: "utf-8" },
  );
  assert(
    lint.status === 1,
    `svelte-lint exited ${lint.status}, not 1:\n${lint.stderr}`,
  );
  const problems = (
    JSON.parse(lint.stdout) as { messages: unknown[] }[]
  ).flatMap((f) => f.messages);
  assert(
    problems.length === 10,
    `svelte-lint found ${problems.length} problems, not 10`,
  );

  const clean = spawnSync(
    "bun",
    ["x", "svelte-lint", "src/Clean.svelte", "src/Legacy.svelte"],
    { cwd: project, encoding: "utf-8" },
  );
  assert(
    clean.status === 0,
    `svelte-lint on clean components exited ${clean.status}:\n${clean.stdout}${clean.stderr}`,
  );

  const { lint: api } = await import(
    join(project, "node_modules/svelte-lint/index.js")
  );
  const result = await api({ cwd: project, cache: false });
  assert(result.errors === 10, `the API found ${result.errors} errors, not 10`);
  console.log("✓ The packed package lints a project from its bin and its API");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
