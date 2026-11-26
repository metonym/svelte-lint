import type { AST, Binding, Reference, Scopes } from "svelte-ast";
import { walk } from "svelte-ast/walk";

// metonym/svelte-lint#3: an `$effect` that writes a `$state` it also reads
// runs again after its own write, until Svelte stops it at run time with
// `effect_update_depth_exceeded`. Only what runs when the effect does
// counts: a nested function runs later, if at all, and `untrack(...)`
// reads without tracking. A write the effect guards with a read of the
// same state (`if (!items.includes(key)) items = [...]`) settles after one
// run, so it isn't reported.

type Range = readonly [number, number];

// Methods that change the array, map or set they're called on, which a
// `$state` proxy turns into a write, so they count as one.
const MUTATORS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
  "set",
  "add",
  "delete",
  "clear",
]);

const FUNCTIONS = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);

const within = (ranges: readonly Range[], at: number) =>
  ranges.some(([start, end]) => at >= start && at < end);

interface Effect {
  /** The function `$effect` runs. */
  body: AST.SvelteNode & { start: number; end: number };
  /** What in it doesn't run with it: nested functions, `untrack`'s argument. */
  deferred: Range[];
  /** Each guard: its test, and the branches it decides. */
  guards: { test: Range; branches: Range[] }[];
  /** `x.push(...)` and the like: the object's start, by name. */
  mutatingCalls: Map<string, number[]>;
}

function rangeOf(node: unknown): Range | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const start: unknown = Reflect.get(node, "start");
  const end: unknown = Reflect.get(node, "end");
  return typeof start === "number" && typeof end === "number"
    ? [start, end]
    : undefined;
}

function isEffectCall(node: AST.SvelteNode, scopes: Scopes): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  const name =
    callee.type === "Identifier"
      ? callee.name
      : callee.type === "MemberExpression" &&
          callee.object.type === "Identifier" &&
          callee.property.type === "Identifier" &&
          !callee.computed &&
          callee.property.name === "pre"
        ? callee.object.name
        : undefined;
  // A binding named `$effect` would be the app's, not the rune.
  return name === "$effect" && scopes.instance.get("$effect") === null;
}

function effectsIn(program: AST.SvelteNode, scopes: Scopes): Effect[] {
  const effects: Effect[] = [];
  walk(program, {
    enter(node) {
      if (!isEffectCall(node, scopes) || node.type !== "CallExpression") return;
      const fn = node.arguments[0];
      if (!fn || !FUNCTIONS.has(fn.type)) return;
      const effect: Effect = {
        body: fn,
        deferred: [],
        guards: [],
        mutatingCalls: new Map(),
      };
      walk(fn, {
        enter(inner) {
          if (inner !== fn && FUNCTIONS.has(inner.type)) {
            const range = rangeOf(inner);
            if (range) effect.deferred.push(range);
          }
          if (inner.type === "CallExpression") {
            const callee = inner.callee;
            if (callee.type === "Identifier" && callee.name === "untrack") {
              for (const arg of inner.arguments) {
                const range = rangeOf(arg);
                if (range) effect.deferred.push(range);
              }
            }
            if (
              callee.type === "MemberExpression" &&
              callee.object.type === "Identifier" &&
              callee.property.type === "Identifier" &&
              !callee.computed &&
              MUTATORS.has(callee.property.name)
            ) {
              const at = effect.mutatingCalls.get(callee.object.name) ?? [];
              at.push(callee.object.start);
              effect.mutatingCalls.set(callee.object.name, at);
            }
          }
          const test =
            inner.type === "IfStatement" ||
            inner.type === "ConditionalExpression"
              ? rangeOf(inner.test)
              : inner.type === "LogicalExpression"
                ? rangeOf(inner.left)
                : undefined;
          if (test) {
            const decided: unknown[] =
              inner.type === "LogicalExpression"
                ? [inner.right]
                : inner.type === "IfStatement" ||
                    inner.type === "ConditionalExpression"
                  ? [inner.consequent, inner.alternate]
                  : [];
            const branches = decided
              .map(rangeOf)
              .filter((r): r is Range => r !== undefined);
            effect.guards.push({ test, branches });
          }
        },
      });
      effects.push(effect);
    },
  });
  return effects;
}

// What an effect reads and writes of each state, counting only what runs
// with it.
interface Uses {
  binding: Binding;
  reads: number[];
  writes: Reference[];
}

function usesIn(effect: Effect, binding: Binding): Uses {
  const [start, end] = rangeOf(effect.body) ?? [0, 0];
  const live = binding.references.filter(
    (r) =>
      r.node.start >= start &&
      r.node.start < end &&
      !within(effect.deferred, r.node.start),
  );
  const mutatedAt = new Set(effect.mutatingCalls.get(binding.name) ?? []);
  return {
    binding,
    reads: live.filter((r) => r.reads).map((r) => r.node.start),
    writes: live.filter(
      (r) => r.writes || r.mutates || mutatedAt.has(r.node.start),
    ),
  };
}

// A write a guard decides settles after one run when the guard reads a
// state the same branch writes, since the rerun skips the branch, as in
// `if (!items.includes(k)) items = [...]`, or svelte-time's
// `if (pausedAt !== undefined) { pausedMs += ...; pausedAt = undefined }`.
function guarded(effect: Effect, at: number, all: readonly Uses[]): boolean {
  return effect.guards.some((g) => {
    const branch = g.branches.find(([s, e]) => at >= s && at < e);
    if (!branch) return false;
    return all.some(
      (u) =>
        u.reads.some((r) => within([g.test], r)) &&
        u.writes.some((w) => within([branch], w.node.start)),
    );
  });
}

// Each write to a `$state` inside an `$effect` that also reads it, for
// the rule in template-rules.ts, apart so the rule stays one call there.
export function effectSelfUpdates(
  ast: AST.Root,
  scopes: Scopes,
): { node: { start: number; end: number }; name: string }[] {
  const program = ast.instance?.content;
  if (!program) return [];
  const states = [...scopes.instance.declarations.values()].filter(
    (b) => b.rune === "$state" || b.rune === "$state.raw",
  );
  if (states.length === 0) return [];
  const found: { node: { start: number; end: number }; name: string }[] = [];
  for (const effect of effectsIn(program, scopes)) {
    const all = states.map((binding) => usesIn(effect, binding));
    for (const uses of all) {
      if (uses.reads.length === 0) continue;
      const write = uses.writes.find(
        (w) => !guarded(effect, w.node.start, all),
      );
      if (write) found.push({ node: write.node, name: uses.binding.name });
    }
  }
  return found;
}
