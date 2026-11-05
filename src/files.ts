import { glob } from "./glob.ts";

const LINE_BREAK = /\r?\n/;

export interface ListMode {
  /** The staged components only. */
  staged?: boolean;
  /** The components that differ from this ref, committed or not; `true` for the default branch. */
  changed?: string | true;
}

/**
 * Runs git in `root`, its output's lines, or `null` if git fails, as
 * outside a repository.
 */
async function git(root: string, ...args: string[]): Promise<string[] | null> {
  const child = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "ignore",
  });
  const [text, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return code === 0 ? text.split(LINE_BREAK).filter(Boolean) : null;
}

/** The ref of the default branch: `origin/HEAD`'s, else `main` or `master`, whichever exists. */
async function defaultBranch(root: string): Promise<string> {
  const [head] =
    (await git(root, "rev-parse", "--abbrev-ref", "origin/HEAD")) ?? [];
  if (head && head !== "origin/HEAD") return head;
  const candidates = ["origin/main", "origin/master", "main", "master"];
  const found = await Promise.all(
    candidates.map((ref) => git(root, "rev-parse", "--verify", "--quiet", ref)),
  );
  const ref = candidates.find((_, n) => found[n]);
  if (ref) return ref;
  throw new Error(
    "--changed found no default branch: name one, as --changed=<ref>",
  );
}

/**
 * The `.svelte` files under `root`, as `/`-separated relative paths: the
 * ones git tracks or would add, or outside a repository, every one but
 * those in `node_modules` and dot folders. With `staged` or `changed`,
 * only those git sees staged, or changed from a ref. It imports nothing
 * heavy, so the CLI can start git before it loads the rest.
 */
export async function listComponents(
  root: string,
  mode: ListMode = {},
): Promise<string[]> {
  // `--relative`: diff names paths from the repository's root otherwise.
  if (mode.staged) {
    const staged = await git(
      root,
      "diff",
      "--cached",
      "--name-only",
      "--relative",
      "--diff-filter=ACMR",
      "--",
      "*.svelte",
    );
    if (!staged) throw new Error("--staged needs a git repository");
    return staged;
  }
  if (mode.changed == null) {
    return (
      (await git(
        root,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        "*.svelte",
      )) ?? glob(root, ["**/*.svelte"])
    );
  }
  const ref = mode.changed === true ? await defaultBranch(root) : mode.changed;
  const [base] = (await git(root, "merge-base", "HEAD", ref)) ?? [];
  if (!base)
    throw new Error(`--changed found no common ancestor of HEAD and ${ref}`);
  const [changed, untracked] = await Promise.all([
    git(
      root,
      "diff",
      "--name-only",
      "--relative",
      "--diff-filter=ACMR",
      base,
      "--",
      "*.svelte",
    ),
    git(root, "ls-files", "--others", "--exclude-standard", "--", "*.svelte"),
  ]);
  return [...new Set([...(changed ?? []), ...(untracked ?? [])])];
}
