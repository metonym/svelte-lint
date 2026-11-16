import { ParseError } from "sveast";
import { a11yWarnings } from "sveast/a11y";
import type { CompilerWarning, Job } from "./compile.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { emit, type Facts, facts, type Segment } from "./emit.ts";
import { lintTemplate, templateRules } from "./template-rules.ts";

export type { CompilerWarning, Job } from "./compile.ts";

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
