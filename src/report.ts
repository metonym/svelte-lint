import { type Diagnostic, lineStarts, position } from "./diagnostic.ts";

export type Format = "pretty" | "agent" | "json" | "github";

export interface Located extends Diagnostic {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  lines: string[];
}

const ANSI = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  reset: "\x1b[0m",
};

/**
 * Set by a coding agent: `AGENT` and `CLAUDECODE`, which `bun lint`
 * reads; `AI_AGENT`, the shared name; and `CODEX_CI` and
 * `CODEX_THREAD_ID`, which Codex sets.
 */
export const AGENT_ENV = [
  "AGENT",
  "AI_AGENT",
  "CLAUDECODE",
  "CODEX_CI",
  "CODEX_THREAD_ID",
];

/**
 * `agent` when an `AGENT_ENV` variable is set to a value other than
 * empty or `0`, as `bun lint` reads its own, else `pretty`.
 */
export function defaultFormat(
  env: Record<string, string | undefined> = process.env,
): Format {
  const agent = AGENT_ENV.some((name) => {
    const value = env[name];
    return value !== undefined && value !== "" && value !== "0";
  });
  return agent ? "agent" : "pretty";
}

/** Each problem with its lines and columns, and its file's lines for a frame. */
export function locate(
  diagnostics: Diagnostic[],
  sources: Map<string, string>,
): Located[] {
  const files = new Map<string, { starts: number[]; lines: string[] }>();
  return diagnostics.map((d) => {
    let file = files.get(d.file);
    if (!file) {
      const source = sources.get(d.file) ?? "";
      file = { starts: lineStarts(source), lines: source.split("\n") };
      files.set(d.file, file);
    }
    const start = position(file.starts, d.start);
    const end = position(file.starts, d.end);
    return {
      ...d,
      line: start.line,
      column: start.column,
      endLine: end.line,
      endColumn: end.column,
      lines: file.lines,
    };
  });
}

export function report(
  diagnostics: Diagnostic[],
  sources: Map<string, string>,
  format: Format,
  color: boolean,
  files: number,
  ms: number,
): string {
  const located = locate(diagnostics, sources);
  if (format === "json") {
    const byFile = new Map<string, Located[]>();
    for (const d of located)
      byFile.set(d.file, [...(byFile.get(d.file) ?? []), d]);
    return JSON.stringify(
      [...byFile].map(([filePath, messages]) => ({
        filePath,
        messages: messages.map((m) => ({
          ruleId: m.rule,
          severity: m.severity === "error" ? 2 : 1,
          message: m.message,
          line: m.line,
          column: m.column,
          endLine: m.endLine,
          endColumn: m.endColumn,
          ...(m.fix
            ? { fix: { range: [m.fix.start, m.fix.end], text: m.fix.text } }
            : {}),
        })),
      })),
    );
  }
  if (format === "github") {
    return located
      .map(
        (d) =>
          `::${d.severity === "error" ? "error" : "warning"} file=${d.file},line=${d.line},col=${d.column},endLine=${d.endLine},endColumn=${d.endColumn},title=${d.rule ?? "syntax"}::${d.message}`,
      )
      .join("\n");
  }
  const c = (code: keyof typeof ANSI, text: string) =>
    color ? `${ANSI[code]}${text}${ANSI.reset}` : text;
  const out: string[] = [];
  for (const d of located) {
    if (format === "agent") {
      const tag = d.severity === "error" ? "error" : "warning";
      out.push(
        `<${tag} file="${d.file}" line="${d.line}" column="${d.column}"${d.rule ? ` rule="${d.rule}"` : ""}${d.fix ? ' fixable="true"' : ""}>`,
        d.message,
        "<source>",
        ...frame(d, (_, t) => t),
        "</source>",
        ...(d.help ? [`<help>${d.help}</help>`] : []),
        `</${tag}>`,
      );
      continue;
    }
    out.push(...frame(d, c));
    const label =
      d.severity === "error" ? c("red", "error") : c("yellow", "warn");
    out.push(
      `${label}${c("dim", ": ")}${c("bold", d.message)}  ${c("dim", d.rule ?? "")}`,
    );
    const gutter = " ".repeat(String(d.line + 1).length + 2);
    out.push(
      `${gutter}${c("dim", "at ")}${c("cyan", d.file)}${c("dim", ":")}${c("yellow", String(d.line))}${c("dim", ":")}${c("yellow", String(d.column))}`,
      "",
    );
    if (d.help)
      out.push(`${c("blue", "note")}${c("dim", ": ")}${c("blue", d.help)}`, "");
  }
  const errors = located.filter((d) => d.severity === "error").length;
  const warnings = located.length - errors;
  const fixable = located.filter((d) => d.fix).length;
  const time = `[${ms.toFixed(2)}ms]`;
  if (located.length === 0) {
    out.push(
      `${c("bold", "✓")} No problems in ${files} ${files === 1 ? "file" : "files"} ${c("dim", time)}`,
    );
    return out.join("\n");
  }
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? "" : "s"}`;
  out.push(
    `${c("bold", plural(located.length, "problem"))} ${c("dim", "(")}${c("red", plural(errors, "error"))}${c("dim", ",")} ${c("yellow", plural(warnings, "warning"))}${c("dim", ")")}`,
  );
  if (fixable)
    out.push(
      `${c("dim", `${fixable} can be fixed with`)} ${c("cyan", "--fix")}`,
    );
  out.push(c("dim", `Linted ${plural(files, "file")} ${time}`));
  return out.join("\n");
}

function frame(
  d: Located,
  c: (code: keyof typeof ANSI, text: string) => string,
): string[] {
  const width = String(d.line + 1).length;
  const row = (n: number, strong: boolean) => {
    const text = d.lines[n - 1];
    if (text == null) return [];
    const gutter = `${String(n).padStart(width)} | `;
    return [`${c(strong ? "bold" : "dim", gutter)}${text}`];
  };
  const caretEnd =
    d.endLine === d.line ? d.endColumn : (d.lines[d.line - 1]?.length ?? 0) + 1;
  const carets = "^".repeat(Math.max(1, caretEnd - d.column));
  const color = d.severity === "error" ? "red" : "yellow";
  return [
    ...row(d.line - 1, false),
    ...row(d.line, true),
    `${" ".repeat(width + 3 + d.column - 1)}${c(color, carets)}`,
    ...row(d.line + 1, false),
  ];
}
