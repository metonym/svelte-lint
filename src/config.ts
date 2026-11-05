import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export type Severity = "error" | "warn" | "off";

type Toml = Record<string, unknown>;

interface Override {
  files: string[];
  excludeFiles?: string[];
  rules?: Record<string, unknown>;
}

/** The `[svelte-lint]` table: the template rules, which `bun lint` doesn't know. */
export interface TemplateConfig {
  rules: Record<string, Severity>;
  overrides: Override[];
  ignorePatterns: string[];
}

function asArray(value: unknown): string[] {
  if (value == null) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function severity(value: unknown): Severity {
  const level = Array.isArray(value) ? value[0] : value;
  if (level === 2 || level === "error") return "error";
  if (level === 1 || level === "warn") return "warn";
  return "off";
}

/**
 * The project's root: the nearest folder with a `bunfig.toml`, from `cwd`
 * up, as `bun lint` finds its config; `cwd` if there's none.
 */
export function findRoot(cwd: string): string {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "bunfig.toml"))) return dir;
    if (dirname(dir) === dir) return cwd;
  }
}

export function readBunfig(root: string): Toml {
  const path = join(root, "bunfig.toml");
  return existsSync(path)
    ? (Bun.TOML.parse(readFileSync(path, "utf8")) as Toml)
    : {};
}

export function templateConfig(
  bunfig: Toml,
  defaults: Record<string, Severity>,
): TemplateConfig {
  const table = (bunfig["svelte-lint"] ?? {}) as Toml;
  const rules = { ...defaults };
  for (const [name, value] of Object.entries((table.rules ?? {}) as Toml)) {
    rules[name] = severity(value);
  }
  const overrides = ((table.overrides ?? []) as Toml[]).map((o) => ({
    files: asArray(o.files),
    excludeFiles: asArray(o.excludeFiles),
    rules: (o.rules ?? {}) as Record<string, unknown>,
  }));
  return { rules, overrides, ignorePatterns: asArray(table.ignorePatterns) };
}

/** The severity of each template rule for `file`, after the overrides that match it. */
export function rulesFor(
  config: TemplateConfig,
  file: string,
): Record<string, Severity> {
  const rules = { ...config.rules };
  for (const override of config.overrides) {
    if (
      !matches(override.files, file) ||
      matches(override.excludeFiles ?? [], file)
    )
      continue;
    for (const [name, value] of Object.entries(override.rules ?? {})) {
      rules[name] = severity(value);
    }
  }
  return rules;
}

const globs = new Map<string, InstanceType<typeof Bun.Glob>>();

function matches(patterns: string[], file: string): boolean {
  return patterns.some((pattern) => {
    let glob = globs.get(pattern);
    if (!glob) {
      // A pattern without a slash matches the file name in any directory.
      glob = new Bun.Glob(pattern.includes("/") ? pattern : `**/${pattern}`);
      globs.set(pattern, glob);
    }
    return glob.match(file);
  });
}

/**
 * Patterns that name `.svelte` files, for the modules that stand in for
 * them: `src/**\/*.svelte` also matches `src/A.svelte.js` and
 * `src/B.svelte.ts`.
 */
function forModules(patterns: string[]): string[] {
  return patterns.flatMap((pattern) =>
    pattern.endsWith(".svelte")
      ? [`${pattern}.js`, `${pattern}.ts`]
      : [pattern],
  );
}

/**
 * `[lint]` from `bunfig.toml`, as a `bunfig.toml` for the directory of
 * modules: the same rules, plugins resolved from the project, and
 * overrides that match the modules as they matched the components.
 */
// The keys that decide how svelte-lint reports, not how `bun lint` lints.
const REPORTING = new Set([
  "maxWarnings",
  "denyWarnings",
  "format",
  "overrides",
]);

export function moduleBunfig(bunfig: Toml, root: string): string {
  const lint = Object.fromEntries(
    Object.entries((bunfig.lint ?? {}) as Toml).filter(
      ([key]) => !REPORTING.has(key),
    ),
  );
  if (lint.plugins) {
    lint.plugins = asArray(lint.plugins).map((p) =>
      p.startsWith(".") && !isAbsolute(p) ? join(root, p) : p,
    );
  }
  if (lint.ignorePatterns)
    lint.ignorePatterns = forModules(asArray(lint.ignorePatterns));
  const overrides = (
    (((bunfig.lint ?? {}) as Toml).overrides ?? []) as Toml[]
  ).map((o) => ({
    ...o,
    files: forModules(asArray(o.files)),
    ...(o.excludeFiles
      ? { excludeFiles: forModules(asArray(o.excludeFiles)) }
      : {}),
  }));

  let toml = "[lint]\n";
  const tables: [string, Toml][] = [];
  for (const [key, value] of Object.entries(lint)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      tables.push([key, value as Toml]);
    } else {
      toml += `${key} = ${tomlValue(value)}\n`;
    }
  }
  for (const [key, value] of tables) {
    toml += `\n[lint.${key}]\n`;
    for (const [k, v] of Object.entries(value))
      toml += `${JSON.stringify(k)} = ${tomlValue(v)}\n`;
  }
  for (const override of overrides) {
    toml += "\n[[lint.overrides]]\n";
    for (const [k, v] of Object.entries(override))
      toml += `${k} = ${tomlValue(v)}\n`;
  }
  return toml;
}

function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(
      ([k, v]) => `${JSON.stringify(k)} = ${tomlValue(v)}`,
    );
    return `{ ${entries.join(", ")} }`;
  }
  throw new Error(`Can't write ${String(value)} to TOML`);
}
