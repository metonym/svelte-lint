import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { version } from "../package.json";
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

const svelteVersion = (root: string): string => {
  const file = join(root, "node_modules/svelte/package.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).version : "";
};

const CODE = /\.[jt]s$/;

/**
 * What every cached result depends on besides the component: svelte-lint
 * itself, `bunfig.toml`, Bun, and the project's svelte. Any change empties
 * the cache. svelte-lint's own code counts as well as its version, so a
 * change to it in development counts too.
 */
export function cacheKey(root: string, bunfig: string): string {
  const parts = [version, bunfig, Bun.revision, svelteVersion(root)];
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
    const cache = JSON.parse(readFileSync(path(root), "utf8")) as CacheFile;
    return cache.key === key ? cache.files : {};
  } catch {
    return {};
  }
}

export function saveCache(
  root: string,
  key: string,
  files: Record<string, Entry>,
): void {
  mkdirSync(dirname(path(root)), { recursive: true });
  writeFileSync(path(root), JSON.stringify({ key, files } satisfies CacheFile));
}
