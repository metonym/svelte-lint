import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { version } from "../package.json";
import { isTable } from "./config.ts";
import type { Diagnostic } from "./diagnostic.ts";

interface CacheFile {
  key: string;
  files: Record<string, Entry>;
}

/**
 * A component's problems, for the source with this hash, last seen with
 * this size and modification time.
 */
export interface Entry {
  hash: string;
  size: number;
  mtime: number;
  diagnostics: Diagnostic[];
}

const path = (root: string) =>
  join(root, "node_modules/.cache/svelte-lint/results.json");

const CODE = /\.[jt]s$/;

/**
 * What every cached result depends on besides the component: svelte-lint
 * itself, with the svelte-ast it bundles, `bunfig.toml` and Bun. Any
 * change empties the cache. svelte-lint's own code counts as well as its
 * version, so a change to it in development counts too.
 */
export function cacheKey(bunfig: string): string {
  const parts = [version, bunfig, Bun.revision];
  for (const file of readdirSync(import.meta.dir).sort()) {
    if (CODE.test(file))
      parts.push(file, readFileSync(join(import.meta.dir, file), "utf8"));
  }
  return hash(parts.join("\0"));
}

export const hash = (text: string): string => Bun.hash(text).toString(36);

export function loadCache(root: string, key: string): Record<string, Entry> {
  if (!existsSync(path(root))) return {};
  try {
    const cache: unknown = JSON.parse(readFileSync(path(root), "utf8"));
    if (!isTable(cache) || cache.key !== key || !isTable(cache.files))
      return {};
    // An entry of another shape is dropped, so its component is linted again.
    return Object.fromEntries(
      Object.entries(cache.files).filter((pair): pair is [string, Entry] =>
        isEntry(pair[1]),
      ),
    );
  } catch {
    return {};
  }
}

function isEntry(value: unknown): value is Entry {
  return (
    isTable(value) &&
    typeof value.hash === "string" &&
    typeof value.size === "number" &&
    typeof value.mtime === "number" &&
    Array.isArray(value.diagnostics)
  );
}

export function saveCache(
  root: string,
  key: string,
  files: Record<string, Entry>,
): void {
  mkdirSync(dirname(path(root)), { recursive: true });
  writeFileSync(path(root), JSON.stringify({ key, files } satisfies CacheFile));
}
