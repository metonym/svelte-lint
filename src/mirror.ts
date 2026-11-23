import {
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";

const MODULE = /\.svelte\.[jt]s$/;
const EXTENSION = /\.[jt]s$/;

function list(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Links `target` at `path`; where links need rights the user lacks, as on
 * Windows, it does without.
 */
function link(target: string, path: string, folder: boolean): void {
  try {
    symlinkSync(target, path, folder ? "junction" : "file");
  } catch {
    // An import of it stays unresolved, as it was before the mirror.
  }
}

/**
 * Makes `dir`, the folder of modules, stand in for `root` to the rules
 * that resolve imports, such as `import/no-unresolved` and
 * `import/no-cycle`. A folder that holds components, or a parent of
 * one, is a real folder here, with links to everything in the project's
 * folder but the components, which their modules stand in for. Any
 * other folder or file is a link. A component is a link until a run
 * writes its module, so an import of it resolves meanwhile, as when a
 * batch imports a component of a later one. A module whose component is
 * gone is removed, so no rule sees its imports.
 */
export function mirror(root: string, dir: string, files: string[]): void {
  const folders = new Set<string>([""]);
  for (const file of files) {
    for (
      let folder = posix.dirname(file);
      folder !== "." && !folders.has(folder);
      folder = posix.dirname(folder)
    ) {
      folders.add(folder);
    }
  }
  // Parents first. A folder found below is deeper than any before it.
  const queue = [...folders].sort(
    (a, b) => a.split("/").length - b.split("/").length,
  );
  for (let n = 0; n < queue.length; n++) {
    const folder = queue[n] ?? "";
    const here = join(dir, folder);
    const there = join(root, folder);
    // A link to the project's folder would put modules in the project.
    if (existsSync(here) && lstatSync(here).isSymbolicLink()) unlinkSync(here);
    mkdirSync(here, { recursive: true });

    const project = new Map(list(there).map((e) => [e.name, e]));
    const mirrored = new Map(list(here).map((e) => [e.name, e]));
    /** Whether a component has a module here, which a link would hide. */
    const isModule = (name: string): boolean =>
      [".js", ".ts"].some((ext) => mirrored.get(name + ext)?.isFile());
    for (const [name, entry] of mirrored) {
      const path = join(here, name);
      const original = project.get(name);
      const child = folder ? `${folder}/${name}` : name;
      if (entry.isSymbolicLink()) {
        // Gone, or now a folder of components, or a component with a module.
        if (
          !original ||
          folders.has(child) ||
          (original.isFile() && name.endsWith(".svelte") && isModule(name))
        )
          unlinkSync(path);
      } else if (entry.isDirectory()) {
        if (original?.isDirectory() || isFolder(join(there, name))) {
          if (!folders.has(child)) {
            folders.add(child);
            queue.push(child);
          }
        } else rmSync(path, { recursive: true, force: true });
      } else if (
        MODULE.test(name) &&
        !project.has(name.replace(EXTENSION, ""))
      ) {
        rmSync(path, { force: true });
      }
    }
    for (const [name, entry] of project) {
      const child = folder ? `${folder}/${name}` : name;
      if (
        name === ".git" ||
        folders.has(child) ||
        (folder === "" && name === "bunfig.toml") ||
        (entry.isFile() && name.endsWith(".svelte") && isModule(name)) ||
        // A module of the project's, such as `store.svelte.js`, unless a
        // component's module has its name.
        (MODULE.test(name) && project.has(name.replace(EXTENSION, "")))
      )
        continue;
      const path = join(here, name);
      if (mirrored.has(name) && existsSync(path)) continue;
      if (mirrored.has(name)) unlinkSync(path);
      link(join(there, name), path, entry.isDirectory());
    }
  }
  // Packages resolve from the nearest `node_modules`, which in a
  // workspace may be a parent's.
  if (!existsSync(join(dir, "node_modules"))) {
    for (let at = dirname(root); at !== dirname(at); at = dirname(at)) {
      if (isFolder(join(at, "node_modules"))) {
        link(join(at, "node_modules"), join(dir, "node_modules"), true);
        break;
      }
    }
  }
}
