import { ParseError } from "svelte-ast";
import { a11yWarnings } from "svelte-ast/a11y";
import { compilerWarnings as portedWarnings } from "svelte-ast/warnings";

import type { Diagnostic } from "./diagnostic.ts";
import { emit, type Facts, facts, type Segment } from "./emit.ts";
import { lintTemplate, templateRules } from "./template-rules.ts";

export interface Job {
  file: string;
  source: string;
  /**
   * Whether `analyze` gives the compiler's other warnings too, from
   * svelte-ast's port of Svelte 5's, without compiling.
   */
  compiler?: boolean;
}

/**
 * What svelte-lint learns about a component, as plain data, so its AST can
 * go.
 */
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
  /**
   * Every template rule's problems, as errors; the main thread applies the
   * config.
   */
  template: Diagnostic[];
  /**
   * The Svelte compiler's a11y warnings, from svelte-ast's port of its
   * checks.
   */
  a11y: CompilerWarning[];
  /**
   * The compiler's other warnings, from svelte-ast's port, when the job asks
   * for them.
   */
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

/**
 * Turns a component into its module and runs the template rules. The AST
 * stays here.
 */
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
    ...warnings(emitted, { compiler, full, source, file }),
  };
}

// One walk of the markup gives both lists when the compiler's warnings
// are wanted, so they come from one call. None when the CSS didn't parse,
// as Svelte fails to compile it too. On the AST `parse` returned, which
// records two of them. No `customElement`, since svelte-lint has no such
// option and `<svelte:options customElement>` counts without it.
function warnings(
  emitted: ReturnType<typeof emit>,
  {
    compiler,
    full,
    source,
    file,
  }: { compiler: boolean; full: boolean; source: string; file: string },
): { a11y: CompilerWarning[]; compiler?: CompilerWarning[] } {
  if (!compiler || !full) {
    return {
      a11y: a11yWarnings(emitted.ast, { runes: emitted.runes }),
      ...(compiler && { compiler: [] }),
    };
  }
  const all = portedWarnings(emitted.ast, {
    source,
    filename: file,
    runes: emitted.runes,
    a11y: true,
  });
  return {
    a11y: all.filter((w) => w.code.startsWith("a11y_")),
    compiler: all.filter((w) => !w.code.startsWith("a11y_")),
  };
}
