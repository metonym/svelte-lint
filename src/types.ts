// The package's public API, as consumers see it: the build copies this file
// as dist/index.d.ts, so it imports nothing and holds only declarations.
// tests/api.test.ts fails when an implementation's signature drifts from
// its declaration here.

/** A change that fixes a problem: replace `start` to `end` of the component with `text`. */
export interface Fix {
  start: number;
  end: number;
  text: string;
}

/** A problem in a component. */
export interface Diagnostic {
  /** The component, relative to the project root. */
  file: string;
  /**
   * The rule: a `[lint]` rule `bun lint` reported, such as `no-unused-vars`,
   * a template rule, such as `svelte/require-each-key`, or a compiler
   * warning, such as `svelte/a11y_missing_attribute`. `null` for a syntax
   * error.
   */
  rule: string | null;
  severity: "error" | "warn";
  message: string;
  /** 1-based, as editors count them. */
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  /** Offsets into the component's source. */
  start: number;
  end: number;
  fix?: Fix;
  /** How to fix it, when the message doesn't say. */
  help?: string;
}

export interface LintOptions {
  /**
   * Where to start looking for the project: its root is the nearest folder
   * with a `bunfig.toml` from here up. Default: `process.cwd()`.
   */
  cwd?: string;
  /** Only the components under these paths, relative to `cwd`. Default: all. */
  paths?: string[];
  /** Only the components staged in git. */
  staged?: boolean;
  /** Only the components that differ from this ref, committed or not; `true` for the default branch. */
  changed?: string | true;
  /** Apply the fixes, and lint the fixed components again, up to 10 times. */
  fix?: boolean;
  /**
   * Keep each component's problems in `node_modules/.cache/svelte-lint`,
   * and lint only the ones that changed. Default `true`.
   */
  cache?: boolean;
}

export interface LintResult {
  /** The project root, which `file` paths are relative to. */
  root: string;
  /** The components linted. */
  files: string[];
  diagnostics: Diagnostic[];
  errors: number;
  warnings: number;
}

/** What a watch knows after a change. */
export interface WatchUpdate {
  /**
   * `template`: the template rules and a11y checks are in, and `bun lint`'s
   * problems from before the change stand until its new ones are. `done`:
   * everything is in. `removed`: components were deleted.
   */
  stage: "template" | "done" | "removed";
  /** Why it ran: the first run, a changed component, or a changed `bunfig.toml`. */
  reason: "start" | "change" | "config";
  /** The components this update is about. */
  changed: string[];
  /** Every watched component's problems. */
  diagnostics: Diagnostic[];
  /** How many components are watched. */
  files: number;
  /** Milliseconds from the change to this update. */
  ms: number;
}

export interface WatchOptions extends Omit<
  LintOptions,
  "staged" | "changed" | "fix"
> {
  onUpdate: (update: WatchUpdate) => void;
}

export interface Watcher {
  close: () => void;
}

/** Lints a project's `.svelte` components. */
export declare function lint(options?: LintOptions): Promise<LintResult>;

/** Lints a project's components, then again each time one, or `bunfig.toml`, changes. */
export declare function watch(options: WatchOptions): Promise<Watcher>;
