/** A problem in a component, at offsets into its source. */
export interface Diagnostic {
  file: string;
  /** `null` for a syntax error. */
  rule: string | null;
  severity: "error" | "warn";
  message: string;
  start: number;
  end: number;
  fix?: Fix;
  help?: string;
}

export interface Fix {
  start: number;
  end: number;
  text: string;
}

/** Offsets of the start of each line, for converting to and from lines and columns. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** 1-based line and column, as ESLint and editors count them. */
export function position(
  starts: number[],
  at: number,
): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= at) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: at - starts[low] + 1 };
}

export function offset(starts: number[], line: number, column: number): number {
  return (starts[line - 1] ?? 0) + column - 1;
}
