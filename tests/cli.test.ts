import { join } from "node:path";
import { FIXTURES } from "./shared.ts";

const CLI = join(import.meta.dir, "../src/cli.ts");

function run(args: string[], cwd = FIXTURES) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd,
    env: { ...process.env, AI_AGENT: "", CLAUDECODE: "" },
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}

describe("cli", () => {
  it("exits 1 on a problem and prints bun lint's pretty format", () => {
    const { code, out } = run([
      "--no-cache",
      "--no-color",
      "src/Problems.svelte",
    ]);
    expect(code).toBe(1);
    expect(out).toContain(
      "error: This button has no type.  svelte/button-has-type",
    );
    expect(out).toContain("at src/Problems.svelte:13:1");
    expect(out).toContain("9 problems (9 errors, 0 warnings)");
  });

  it("exits 0 with nothing to report", () => {
    const { code, out } = run([
      "--no-cache",
      "--no-color",
      "src/Clean.svelte",
      "src/Legacy.svelte",
    ]);
    expect(code).toBe(0);
    expect(out).toContain("✓ No problems in 2 files");
  });

  it("prints JSON and GitHub annotations", () => {
    const json = JSON.parse(
      run(["--no-cache", "--format=json", "src/Syntax.svelte"]).out,
    );
    expect(json[0].messages[0]).toMatchObject({
      ruleId: null,
      line: 3,
      severity: 2,
    });
    const github = run([
      "--no-cache",
      "--format=github",
      "src/Syntax.svelte",
    ]).out;
    expect(github).toStartWith("::error file=src/Syntax.svelte,line=3,");
  });

  it("rejects a bad flag, or --watch with --fix, with exit code 2", () => {
    expect(run(["--nope"]).code).toBe(2);
    expect(run(["--format=xml"]).code).toBe(2);
    expect(run(["--watch", "--fix"]).code).toBe(2);
    expect(run(["--help"]).out).toStartWith("Usage: svelte-lint");
  });
});
