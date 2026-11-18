import { ParseError } from "sveast";
import { a11yWarnings } from "sveast/a11y";
import { compilerWarnings as portedWarnings } from "sveast/warnings";
import type { compile } from "svelte/compiler";
import type { Diagnostic } from "./diagnostic.ts";
import { emit, type Facts, facts, type Segment } from "./emit.ts";
import { lintTemplate, templateRules } from "./template-rules.ts";

export interface Job {
  file: string;
  source: string;
  /**
   * Whether `analyze` gives the compiler's other warnings too, from
   * sveast's port of Svelte 5's, without compiling.
   */
  compiler?: boolean;
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
  /** The compiler's other warnings, from sveast's port, when the job asks for them. */
  compiler?: CompilerWarning[];
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

/** The warning with its message's first line; the second links to the docs. */
const firstLine = (w: CompilerWarning): CompilerWarning => ({
  ...w,
  message: w.message.split("\n")[0],
});

/**
 * Parses `source` with its CSS and comments when the compiler's warnings
 * need them. If its CSS doesn't parse, as `<style lang="scss">` doesn't,
 * Svelte fails to compile it too, so it has no such warnings, and the
 * rest is linted as without them.
 */
function emitFor(
  source: string,
  compiler: boolean,
): { emitted: ReturnType<typeof emit>; full: boolean } {
  if (compiler) {
    try {
      return { emitted: emit(source, true), full: true };
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
    }
  }
  return { emitted: emit(source), full: false };
}

/** Turns a component into its module and runs the template rules. The AST stays here. */
export function analyze({ file, source, compiler = false }: Job): Analysis {
  let emitted: ReturnType<typeof emit>;
  let full: boolean;
  try {
    ({ emitted, full } = emitFor(source, compiler));
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
    compiler: compiler ? ported(emitted, { full, source, file }) : undefined,
  };
}

/**
 * sveast's port of the compiler's warnings, or none when the CSS didn't
 * parse. On the AST `parse` returned, which records two of them. No
 * `customElement`: svelte-lint has no such option, and
 * `<svelte:options customElement>` counts without it.
 */
function ported(
  emitted: ReturnType<typeof emit>,
  { full, source, file }: { full: boolean; source: string; file: string },
): CompilerWarning[] {
  if (!full) return [];
  return portedWarnings(emitted.ast, {
    source,
    filename: file,
    runes: emitted.runes,
  }).map(firstLine);
}

type Compile = typeof compile;
const compilers = new Map<string, Compile>();

/**
 * The project's Svelte compiler's warnings for each component, but its
 * a11y ones, which `analyze` has, by compiling: for Svelte 3 and 4,
 * which warn differently from the Svelte 5 that sveast ports. The
 * compiler loads from `root` on the first call.
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
        .map((w) =>
          firstLine({
            code: w.code,
            message: w.message,
            start: w.start?.character ?? 0,
            end: w.end?.character ?? w.start?.character ?? 0,
          }),
        );
    } catch {
      // A compile error the parser didn't catch, such as a bad rune call,
      // which the compiler reports when the component builds.
      return [];
    }
  });
}
