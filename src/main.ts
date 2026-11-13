import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { count, select } from "./api.ts";
import { readBunfig } from "./config.ts";
import { lint, lintAndFix } from "./lint.ts";
import { defaultFormat, type Format, report } from "./report.ts";
import { watchComponents } from "./watch.ts";

const HELP = `Usage: svelte-lint [options] [paths...]

Lints Svelte components: their scripts and markup expressions with
\`bun lint\` and the [lint] rules in bunfig.toml, and their markup with
the template rules and a11y checks [svelte-lint] turns on.

  --fix                 Apply the fixes, then lint the fixed components again
  --staged              Only the components staged in git
  --changed[=<ref>]     Only the components that differ from <ref>, committed
                        or not (default: the default branch)
  --watch               Lint again each time a component or bunfig.toml
                        changes
  --format <name>       pretty, agent, json or github (default: agent for a
                        coding agent: AGENT, AI_AGENT, CLAUDECODE,
                        CODEX_CI or CODEX_THREAD_ID set, and not to 0;
                        else pretty)
  --max-warnings <n>    Exit 1 on more warnings than this (default: [lint]'s
                        maxWarnings)
  --no-cache            Lint every component, and keep no cache
  --color, --no-color   Force color on or off
  -h, --help            Show this help
  -v, --version         Show the version

Exits 1 on an error, or on more warnings than --max-warnings.`;

const FORMATS: readonly Format[] = ["pretty", "agent", "json", "github"];

function parse(argv: string[]) {
  return parseArgs({
    // `--changed` takes an optional ref, which parseArgs can't: an empty
    // one means the default branch.
    args: argv.map((arg) => (arg === "--changed" ? "--changed=" : arg)),
    allowPositionals: true,
    options: {
      fix: { type: "boolean" },
      staged: { type: "boolean" },
      changed: { type: "string" },
      watch: { type: "boolean" },
      format: { type: "string" },
      "max-warnings": { type: "string" },
      "no-cache": { type: "boolean" },
      color: { type: "boolean" },
      "no-color": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}

/** A watch update's status line: what changed and how long it took. */
function watchStatus(update: {
  stage: string;
  reason: string;
  changed: string[];
  ms: number;
}): string {
  if (update.stage === "removed")
    return `Removed ${update.changed.join(", ")}.`;
  let what = `${update.changed.length} files`;
  if (update.reason === "config") what = "bunfig.toml changed";
  else if (update.changed.length === 1) what = update.changed[0] ?? what;
  const when =
    update.stage === "template"
      ? "template done, scripts…"
      : `${update.ms.toFixed(0)}ms`;
  return `${what}: ${when}.`;
}

/** Runs the CLI and returns its exit code. */
export async function main(argv: string[]): Promise<0 | 1 | 2> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    const { version } = await import("../package.json");
    console.log(version);
    return 0;
  }
  const format = (values.format ?? defaultFormat()) as Format;
  if (!FORMATS.includes(format)) {
    console.error(`--format takes ${FORMATS.join(", ")}, not ${format}`);
    return 2;
  }
  if (values.watch && (values.fix || values.staged || values.changed != null)) {
    console.error(
      "--watch takes none of --fix, --staged and --changed: a fix would change the files it watches.",
    );
    return 2;
  }
  const color =
    values.color ??
    (!values["no-color"] &&
      process.stdout.isTTY === true &&
      !process.env.NO_COLOR);
  const cache = !values["no-cache"];
  const started = performance.now();

  let selected: Awaited<ReturnType<typeof select>>;
  try {
    selected = await select(resolve(process.cwd()), positionals, {
      staged: values.staged,
      changed: values.changed === "" ? true : values.changed,
    });
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  const { root, files, paths } = selected;

  if (values.watch) {
    await watchComponents({
      root,
      files,
      paths,
      cache,
      onUpdate: (update) => {
        const out = report(
          update.diagnostics,
          update.sources,
          format,
          color,
          update.files,
          update.ms,
        );
        const status = watchStatus(update);
        // Start from a clear screen in a terminal, as `tsc --watch` does.
        const clear = process.stdout.isTTY ? "\x1b[2J\x1b[H" : "\n";
        process.stdout.write(
          `${clear}${out}\n${status} Watching ${update.files} files.\n`,
        );
      },
    });
    // Until interrupted.
    return new Promise<never>(() => {});
  }

  const run = values.fix ? lintAndFix : lint;
  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run(root, files, { cache });
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  const output = report(
    result.diagnostics,
    result.sources,
    format,
    color,
    files.length,
    performance.now() - started,
  );
  if (output) console.log(output);

  const { maxWarnings } = (readBunfig(root).lint ?? {}) as {
    maxWarnings?: number;
  };
  const limit = Number(values["max-warnings"] ?? maxWarnings ?? -1);
  const { errors, warnings } = count(result.diagnostics);
  return errors > 0 || (limit >= 0 && warnings > limit) ? 1 : 0;
}
