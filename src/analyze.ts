import { ParseError } from "sveast";
import { a11yWarnings } from "sveast/a11y";
import type { compile } from "svelte/compiler";
import type { Diagnostic } from "./diagnostic.ts";
import { emit, type Facts, facts, type Segment } from "./emit.ts";
import { lintTemplate, templateRules } from "./template-rules.ts";

export interface Job {
  file: string;
  source: string;
}

/** What svelte-lint learns about a component, as plain data, so its AST can go. */
export interface Analysis {
  file: string;
  /** The module for `bun lint`; absent after a syntax error. */
  module?: {
    code: string;
    typescript: boolean;
    scripts: [number, number][];
    segments: Segment[];
    facts: Facts;
  };
  /** Every template rule's problems, as errors; the main thread applies the config. */
  template: Diagnostic[];
  /** The Svelte compiler's a11y warnings, from sveast's port of its checks. */
  a11y: CompilerWarning[];
  syntax?: Diagnostic;
}

export interface CompilerWarning {
  code: string;
  message: string;
  start: number;
  end: number;
}

const ALL_RULES = Object.fromEntries(
  Object.keys(templateRules).map((name) => [name, "error" as const]),
);

/** Turns a component into its module and runs the template rules. The AST stays here. */
export function analyze({ file, source }: Job): Analysis {
  let emitted: ReturnType<typeof emit>;
  try {
    emitted = emit(source);
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    const [start, end] = error.position ?? [0, 0];
    return {
      file,
      template: [],
      a11y: [],
      syntax: {
        file,
        rule: null,
        severity: "error",
        message: error.reason,
        start,
        end,
      },
    };
  }
  return {
    file,
    module: {
      code: emitted.code,
      typescript: emitted.typescript,
      scripts: emitted.scripts,
      segments: emitted.segments,
      facts: facts(emitted),
    },
    template: lintTemplate(file, source, emitted, ALL_RULES),
    a11y: a11yWarnings(emitted.ast, { runes: emitted.runes }),
  };
}

type Compile = typeof compile;
const compilers = new Map<string, Compile>();

/**
 * The project's Svelte compiler's warnings for each component, but its
 * a11y ones, which `analyze` has, so Svelte 3, 4 and 5 each warn as they
 * compile. The compiler loads from `root` on the first call.
 */
export async function compilerWarnings(
  root: string,
  jobs: Job[],
): Promise<CompilerWarning[][]> {
  if (jobs.length === 0) return [];
  let run = compilers.get(root);
  if (!run) {
    let path: string;
    try {
      path = Bun.resolveSync("svelte/compiler", root);
    } catch {
      throw new Error(
        `"svelte/compiler" is on in [svelte-lint], but svelte isn't installed in ${root}`,
      );
    }
    run = ((await import(path)) as { compile: Compile }).compile;
    compilers.set(root, run);
  }
  const compile = run;
  return jobs.map(({ file, source }) => {
    try {
      return compile(source, {
        filename: file,
        generate: false,
      } as never)
        .warnings.filter((w) => !w.code.startsWith("a11y"))
        .map((w) => ({
          code: w.code,
          // The first line; the second links to the docs.
          message: w.message.split("\n")[0],
          start: w.start?.character ?? 0,
          end: w.end?.character ?? w.start?.character ?? 0,
        }));
    } catch {
      // A compile error the parser didn't catch, such as a bad rune call,
      // which the compiler reports when the component builds.
      return [];
    }
  });
}
