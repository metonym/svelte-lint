import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

export const FIXTURES = join(import.meta.dir, "fixtures");

/**
 * A copy of the fixture project in its own git repository, committed, so
 * a test can change, stage and lint it. Inside this repository, so the
 * project's `svelte` resolves.
 */
export async function workspace(name: string): Promise<string> {
  const dir = join(import.meta.dir, ".tmp", name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await cp(FIXTURES, dir, { recursive: true });
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "-A"],
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "-m",
      "fixtures",
    ],
  ]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: dir });
    if (result.exitCode !== 0)
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return dir;
}

/** `rule@line`, for comparing problems without their messages. */
export const brief = (d: { file: string; rule: string | null; line: number }) =>
  `${d.file}:${d.line} ${d.rule ?? "syntax"}`;
