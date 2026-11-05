import type { AST } from "sveast";
import { markupVisitorKeys, walk } from "sveast/walk";
import type { Diagnostic, Fix } from "./diagnostic.ts";
import type { Emitted } from "./emit.ts";

type Element = AST.RegularElement | AST.SvelteElement | AST.Component;

interface Context {
  emitted: Emitted;
  source: string;
  report(
    node: { start: number; end: number },
    message: string,
    fix?: Fix,
    help?: string,
  ): void;
}

interface TemplateRule {
  description: string;
  check(element: Element, context: Context): void;
  each?(block: AST.EachBlock, context: Context): void;
}

function attribute(element: Element, name: string): AST.Attribute | undefined {
  const html = element.type === "RegularElement";
  return element.attributes.find(
    (a): a is AST.Attribute =>
      a.type === "Attribute" &&
      (html ? a.name.toLowerCase() === name : a.name === name),
  );
}

/** An attribute's value when the markup spells it out, `true` for a bare one, else `undefined`. */
function staticValue(
  attr: AST.Attribute | undefined,
): string | true | undefined {
  if (!attr) return undefined;
  if (attr.value === true) return true;
  const values = Array.isArray(attr.value) ? attr.value : [attr.value];
  if (values.length === 1) {
    const [value] = values;
    if (value.type === "Text") return value.data;
    if (value.expression.type === "Literal")
      return String(value.expression.value);
  }
  return undefined;
}

const hasSpread = (element: Element): boolean =>
  element.attributes.some((a) => a.type === "SpreadAttribute");

const FOCUSABLE = new Set([
  "button",
  "select",
  "textarea",
  "iframe",
  "summary",
]);

function isFocusable(element: Element): boolean {
  if (element.type !== "RegularElement") return false;
  const name = element.name.toLowerCase();
  const tabindex = staticValue(attribute(element, "tabindex"));
  if (typeof tabindex === "string" && Number(tabindex) < 0) return false;
  if (tabindex !== undefined) return true;
  if (FOCUSABLE.has(name)) return true;
  if ((name === "a" || name === "area") && attribute(element, "href"))
    return true;
  if (name === "input")
    return staticValue(attribute(element, "type")) !== "hidden";
  return attribute(element, "contenteditable") != null;
}

/** Rules for the markup, which a linter for JavaScript can't see. */
export const templateRules: Record<string, TemplateRule> = {
  "svelte/require-each-key": {
    description:
      "Key `{#each}` blocks, so Svelte moves rows instead of rewriting them.",
    check() {},
    each(block, context) {
      if (block.key || !block.context) return;
      const end = block.context.end;
      context.report(
        { start: block.start, end },
        "This {#each} block has no key.",
        undefined,
        "Add a key, as in {#each items as item (item.id)}.",
      );
    },
  },
  "svelte/no-bind-value-on-checkable-inputs": {
    description:
      "Bind a checkbox's `checked` or a radio's `group`, not its `value`.",
    check(element, context) {
      if (
        element.type !== "RegularElement" ||
        element.name.toLowerCase() !== "input"
      )
        return;
      const type = staticValue(attribute(element, "type"));
      if (type !== "checkbox" && type !== "radio") return;
      for (const a of element.attributes) {
        if (a.type !== "BindDirective" || a.name !== "value") continue;
        const name = type === "checkbox" ? "checked" : "group";
        const nameStart = a.start + "bind:".length;
        context.report(
          a,
          `bind:value doesn't track whether this ${type} is checked.`,
          type === "checkbox"
            ? { start: nameStart, end: nameStart + 5, text: name }
            : undefined,
          `Use bind:${name}.`,
        );
      }
    },
  },
  "svelte/button-has-type": {
    description:
      "Give a `<button>` a `type`: one in a form submits it by default.",
    check(element, context) {
      if (
        element.type !== "RegularElement" ||
        element.name.toLowerCase() !== "button"
      )
        return;
      const type = attribute(element, "type");
      if (!type) {
        // `{...$$restProps}` may pass one.
        if (hasSpread(element)) return;
        context.report(
          { start: element.start, end: element.start + 7 },
          "This button has no type.",
          undefined,
          'Add type="button", or type="submit" for one that submits a form.',
        );
        return;
      }
      const value = staticValue(type);
      if (
        typeof value === "string" &&
        !["button", "submit", "reset"].includes(value)
      ) {
        context.report(type, `"${value}" isn't a button type.`);
      }
    },
  },
  "svelte/no-aria-hidden-on-focusable": {
    description: "Don't hide a focusable element from assistive technology.",
    check(element, context) {
      const hidden = attribute(element, "aria-hidden");
      if (staticValue(hidden) !== "true" || !isFocusable(element) || !hidden)
        return;
      context.report(
        hidden,
        'aria-hidden="true" hides a focusable element from screen readers, but not from the keyboard.',
        undefined,
        'Remove aria-hidden, or add tabindex="-1" to take it out of the tab order.',
      );
    },
  },
};

const ELEMENTS = new Set(["RegularElement", "SvelteElement", "Component"]);

/** Runs the template rules that are on, `severity` by name, over one component. */
export function lintTemplate(
  file: string,
  source: string,
  emitted: Emitted,
  severities: Record<string, "error" | "warn" | "off">,
): Diagnostic[] {
  const active = Object.entries(templateRules).filter(
    ([name]) => (severities[name] ?? "off") !== "off",
  );
  if (active.length === 0) return [];
  const diagnostics: Diagnostic[] = [];
  const contexts = active.map(([name, rule]) => {
    const context: Context = {
      emitted,
      source,
      report(node, message, fix, help) {
        diagnostics.push({
          file,
          rule: name,
          severity: severities[name] === "warn" ? "warn" : "error",
          message,
          start: node.start,
          end: node.end,
          fix,
          help,
        });
      },
    };
    return { rule, context };
  });
  walk(
    emitted.ast.fragment as never,
    {
      enter(node) {
        const n = node as unknown as { type: string };
        if (ELEMENTS.has(n.type)) {
          for (const { rule, context } of contexts)
            rule.check(n as Element, context);
        } else if (n.type === "EachBlock") {
          for (const { rule, context } of contexts)
            rule.each?.(n as AST.EachBlock, context);
        }
      },
    },
    markupVisitorKeys,
  );
  return diagnostics;
}
