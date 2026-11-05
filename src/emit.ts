import { analyzeScopes, type AST, isRunesMode, parse } from "sveast";
import { SKIP, visitorKeys, walk } from "sveast/walk";

type Scopes = ReturnType<typeof analyzeScopes>;
interface Node {
  type: string;
  start: number;
  end: number;
}
interface Identifier extends Node {
  type: "Identifier";
  name: string;
}

/** A markup expression copied into the module, at `module` instead of `source`. */
export interface Segment {
  module: number;
  source: number;
  length: number;
}

/**
 * A component as a JavaScript or TypeScript module that `bun lint` can read.
 *
 * Its `<script>`s keep their offsets: everything around them is blanked
 * to spaces, line breaks kept, so a problem in a script is at the same
 * line and column in the component. What the markup and Svelte do to the
 * scripts' names follows: which ones the markup reads and writes, that a
 * parent writes the props, that `$count` reads `count`, and the names
 * Svelte declares, such as `$:` targets and runes. That part sits in
 * `eslint-disable` comments. The markup's expressions come last, each in
 * a `Segment`, so only the scripts and the expressions are linted.
 */
export interface Emitted {
  code: string;
  typescript: boolean;
  /** Script ranges, `[start, end)`, the same in the module and the component. */
  scripts: [number, number][];
  segments: Segment[];
  ast: AST.Root;
  scopes: Scopes;
  runes: boolean;
}

/**
 * What `isSvelteIdiom` needs to know about a component, as offsets, so
 * its AST can go once the module is written.
 */
export interface Facts {
  runes: boolean;
  /** Identifiers that declare or use a top-level variable of `<script>`. */
  instance: number[];
  /** Identifiers that declare a prop. */
  props: number[];
  /** Identifiers declared from `$props()` or `$derived`. */
  letRunes: number[];
  /** Each top-level `$:` label, `[start, end]`. */
  labels: [number, number][];
}

const PROPS_OR_DERIVED = /^\$(props|derived)\b/;

export function facts(emitted: Emitted): Facts {
  const { scopes } = emitted;
  const result: Facts = {
    runes: emitted.runes,
    instance: [],
    props: [],
    letRunes: [],
    labels: [],
  };
  for (const binding of scopes.instance.declarations.values()) {
    if (binding.node) result.instance.push(binding.node.start);
    for (const reference of binding.references)
      result.instance.push(reference.node.start);
    if (binding.prop && binding.node) result.props.push(binding.node.start);
    if (binding.node && PROPS_OR_DERIVED.test(binding.rune ?? "")) {
      result.letRunes.push(binding.node.start);
    }
  }
  for (const statement of emitted.ast.instance?.content.body ?? []) {
    if (statement.type === "LabeledStatement" && statement.label.name === "$") {
      result.labels.push([statement.start, statement.label.end]);
    }
  }
  return result;
}

const DECLARED_BY_SVELTE = [
  "$$props",
  "$$restProps",
  "$$slots",
  "$state",
  "$derived",
  "$effect",
  "$props",
  "$bindable",
  "$inspect",
  "$host",
];

// Fields that declare names rather than hold expressions.
const DECLARES = new Set([
  "EachBlock.context",
  "AwaitBlock.value",
  "AwaitBlock.error",
  "SnippetBlock.expression",
  "SnippetBlock.parameters",
  "LetDirective.expression",
]);

const LINE = /[^\n\r]+/g;
const TYPESCRIPT = /^(ts|typescript)$/;

/** `text` as spaces, line breaks kept: a run at a time, 3x faster than a character at a time. */
function blank(text: string): string {
  return text.replace(LINE, (run) => " ".repeat(run.length));
}

function isTypeScript(script: AST.Script | null): boolean {
  for (const attribute of script?.attributes ?? []) {
    if (attribute.name !== "lang" || !Array.isArray(attribute.value)) continue;
    const [value] = attribute.value;
    if (value?.type === "Text" && TYPESCRIPT.test(value.data)) {
      return true;
    }
  }
  return false;
}

/** The markup's expressions, outermost first, in source order. */
function markupExpressions(fragment: AST.Fragment): Node[] {
  const found: Node[] = [];
  const visit = (node: Node): void => {
    const keys = visitorKeys[node.type as keyof typeof visitorKeys] ?? [];
    for (const key of keys) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (child == null || typeof child !== "object") continue;
      const children = (Array.isArray(child) ? child : [child]) as Node[];
      for (const value of children) {
        if (value == null || typeof value !== "object" || !value.type) continue;
        if (isMarkup(value)) {
          visit(value);
        } else if (DECLARES.has(`${node.type}.${key}`)) {
          // A pattern: its default values are rare enough to skip.
        } else if (value.type === "VariableDeclaration") {
          // `{@const a = b}`: lint `b`.
          for (const declarator of (
            value as unknown as { declarations: { init: Node | null }[] }
          ).declarations) {
            if (declarator.init) found.push(declarator.init);
          }
        } else {
          found.push(value);
        }
      }
    }
  };
  visit(fragment as unknown as Node);
  return found;
}

const MARKUP_TYPES = new Set([
  "Fragment",
  "Text",
  "Comment",
  "ExpressionTag",
  "HtmlTag",
  "ConstTag",
  "DeclarationTag",
  "DebugTag",
  "RenderTag",
  "AttachTag",
  "Attribute",
  "SpreadAttribute",
  "AnimateDirective",
  "BindDirective",
  "ClassDirective",
  "LetDirective",
  "OnDirective",
  "StyleDirective",
  "TransitionDirective",
  "UseDirective",
  "Component",
  "TitleElement",
  "SlotElement",
  "RegularElement",
  "SvelteBody",
  "SvelteBoundary",
  "SvelteComponent",
  "SvelteDocument",
  "SvelteElement",
  "SvelteFragment",
  "SvelteHead",
  "SvelteOptions",
  "SvelteSelf",
  "SvelteWindow",
  "IfBlock",
  "EachBlock",
  "AwaitBlock",
  "KeyBlock",
  "SnippetBlock",
]);

function isMarkup(node: Node): boolean {
  return MARKUP_TYPES.has(node.type);
}

function identifiers(node: Node): Identifier[] {
  const found: Identifier[] = [];
  walk(node as never, {
    enter(child) {
      if ((child as Node).type === "Identifier")
        found.push(child as Identifier);
    },
  });
  return found;
}

// The names the markup declares, as opposed to an expression's own.
const MARKUP_KINDS = new Set([
  "each",
  "each-index",
  "let-directive",
  "snippet",
  "snippet-param",
  "const-tag",
  "await-value",
  "await-error",
]);

const FUNCTIONS = new Set([
  "FunctionExpression",
  "ArrowFunctionExpression",
  "FunctionDeclaration",
]);

/** Whether `node` awaits outside the functions in it, as `{await a}` can. */
function hasAwait(node: Node): boolean {
  let found = false;
  walk(node as never, {
    enter(child) {
      const { type } = child as unknown as Node;
      if (type === "AwaitExpression") found = true;
      return found || FUNCTIONS.has(type) ? SKIP : undefined;
    },
  });
  return found;
}

/** Turns `source`, a component, into a module for `bun lint`. */
export function emit(source: string): Emitted {
  // The scripts are copied as text, so the AST needs no comments.
  const ast = parse(source, { css: false, comments: false });
  const scopes = analyzeScopes(ast);
  const runes = isRunesMode(source);
  const scriptNodes = [ast.module, ast.instance].filter((s) => s != null);
  const scripts = scriptNodes
    .map((s): [number, number] => [s.content.start, s.content.end])
    .sort((a, b) => a[0] - b[0]);
  const typescript = scriptNodes.some(isTypeScript);

  let code = "";
  let last = 0;
  for (const [start, end] of scripts) {
    code += blank(source.slice(last, start)) + source.slice(start, end);
    last = end;
  }
  code += blank(source.slice(last));

  const top = new Set([scopes.module, scopes.instance]);
  const inScript = (offset: number): boolean =>
    scripts.some(([start, end]) => offset >= start && offset < end);

  const reads = new Set<string>();
  const writes = new Set<string>();
  const declare = new Set<string>(DECLARED_BY_SVELTE);
  for (const scope of top) {
    for (const binding of scope.declarations.values()) {
      if (binding.kind === "reactive") declare.add(binding.name);
      const variable =
        binding.kind === "let" ||
        binding.kind === "var" ||
        binding.kind === "reactive";
      // A parent writes a prop.
      if (binding.prop && variable) writes.add(binding.name);
      for (const reference of binding.references) {
        if (reference.store) {
          reads.add(binding.name);
          declare.add(`$${binding.name}`);
          // `$count = 1` sets the store.
          reads.add(`$${binding.name}`);
        }
        if (inScript(reference.node.start)) continue;
        if (reference.reads) reads.add(binding.name);
        if (reference.writes && variable) writes.add(binding.name);
      }
    }
  }
  // A top-level snippet is in the markup's scope, so a script that passes
  // one along refers to a global.
  for (const node of ast.fragment.nodes) {
    if (node.type === "SnippetBlock") declare.add(node.expression.name);
  }
  for (const scope of top) {
    for (const [name, binding] of scope.declarations) {
      if (binding.kind !== "reactive") declare.delete(name);
    }
  }

  // `debugger` is reported by bun lint's default rules, so the directive
  // is always used and bun lint doesn't report it.
  code += "\n/* eslint-disable */\ndebugger;\n";
  code += `var __svelte, ${[...declare].join(", ")};\n`;
  code += `(() => { ${[...reads].map((name) => `${name};`).join(" ")} ${[
    ...writes,
  ]
    .map((name) => `${name} = ${name};`)
    .join(" ")} });\n/* eslint-enable */\n`;

  const segments: Segment[] = [];
  for (const expression of markupExpressions(ast.fragment)) {
    const local = new Set<string>();
    for (const id of identifiers(expression)) {
      const binding = scopes.bindingOf(id as never);
      if (binding && MARKUP_KINDS.has(binding.kind)) local.add(binding.name);
    }
    // Names the markup declares, such as an each block's item, are the
    // parameters of a function around the expression, which uses them all.
    const open =
      local.size > 0
        ? `__svelte(${hasAwait(expression) ? "async " : ""}(${[...local].join(", ")}) => (`
        : "__svelte(";
    code += open;
    segments.push({
      module: code.length,
      source: expression.start,
      length: expression.end - expression.start,
    });
    code += `${source.slice(expression.start, expression.end)}${local.size > 0 ? "))" : ")"};\n`;
  }

  return { code, typescript, scripts, segments, ast, scopes, runes };
}

/** The component offset for `offset` in the module, or `null` outside the linted code. */
export function toSource(
  emitted: Pick<Emitted, "scripts" | "segments">,
  offset: number,
): number | null {
  for (const [start, end] of emitted.scripts) {
    if (offset >= start && offset <= end) return offset;
  }
  for (const segment of emitted.segments) {
    if (offset >= segment.module && offset <= segment.module + segment.length) {
      return segment.source + offset - segment.module;
    }
  }
  return null;
}
