/**
 * Generic condition evaluator for SOP steps and rules. Conditions are plain JSON —
 * no user-provided code is ever executed — so new client rules are data, not code:
 *
 *   { "field": "issue.type", "operator": "EQUALS", "value": "BUG" }
 *   { "all": [ ...conditions ] }   // AND
 *   { "any": [ ...conditions ] }   // OR
 *   { "not": condition }
 *
 * `field` is a dotted path into the evaluation context built by the engine, e.g.
 * `issue.priority`, `issue.component.name`, `issue.fields.riskLevel`, `note.path`,
 * `steps.qa-testing.result`, `event.step.key`. Unknown paths resolve to undefined
 * (so EXISTS is false and comparisons fail) rather than erroring, which keeps old
 * conditions safe when the context grows.
 */

export const CONDITION_OPERATORS = [
  "EQUALS",
  "NOT_EQUALS",
  "CONTAINS",
  "NOT_CONTAINS",
  "IN",
  "NOT_IN",
  "GREATER_THAN",
  "GREATER_THAN_OR_EQUAL",
  "LESS_THAN",
  "LESS_THAN_OR_EQUAL",
  "STARTS_WITH",
  "ENDS_WITH",
  "EXISTS",
  "NOT_EXISTS",
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** Roots a condition `field` may start with; see SopContext in sop-engine.ts. */
export const CONDITION_ROOTS = ["issue", "task", "note", "steps", "event", "execution"] as const;

export const CONDITION_FIELD_PATTERN = new RegExp(
  `^(${CONDITION_ROOTS.join("|")})(\\.[A-Za-z0-9_-]+)+$`
);

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { field: string; operator: ConditionOperator; value?: unknown };

const MAX_DEPTH = 10;

export function resolvePath(context: unknown, path: string): unknown {
  let current: unknown = context;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Numbers compare as numbers; Dates (or ISO strings compared against a Date) by time. */
function comparable(actual: unknown, expected: unknown): [number, number] | null {
  if (typeof actual === "number" && typeof expected === "number") return [actual, expected];
  const toTime = (v: unknown) =>
    v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : NaN;
  if (actual instanceof Date || expected instanceof Date) {
    const a = toTime(actual);
    const e = toTime(expected);
    return Number.isNaN(a) || Number.isNaN(e) ? null : [a, e];
  }
  return null;
}

function equals(actual: unknown, expected: unknown) {
  if (actual instanceof Date) {
    const pair = comparable(actual, expected);
    return pair !== null && pair[0] === pair[1];
  }
  return actual === expected;
}

function compare(operator: ConditionOperator, actual: unknown, expected: unknown): boolean {
  switch (operator) {
    case "EXISTS":
      return actual !== null && actual !== undefined;
    case "NOT_EXISTS":
      return actual === null || actual === undefined;
    case "EQUALS":
      return equals(actual, expected);
    case "NOT_EQUALS":
      return !equals(actual, expected);
    case "CONTAINS":
      if (Array.isArray(actual)) return actual.includes(expected);
      return typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
    case "NOT_CONTAINS":
      return !compare("CONTAINS", actual, expected);
    case "IN":
      if (!Array.isArray(expected)) return false;
      // Array-valued fields (e.g. labels) match when any element is in the list.
      return Array.isArray(actual) ? actual.some((v) => expected.includes(v)) : expected.includes(actual);
    case "NOT_IN":
      return Array.isArray(expected) && !compare("IN", actual, expected);
    case "STARTS_WITH":
      return typeof actual === "string" && typeof expected === "string" && actual.startsWith(expected);
    case "ENDS_WITH":
      return typeof actual === "string" && typeof expected === "string" && actual.endsWith(expected);
    case "GREATER_THAN":
    case "GREATER_THAN_OR_EQUAL":
    case "LESS_THAN":
    case "LESS_THAN_OR_EQUAL": {
      const pair = comparable(actual, expected);
      if (!pair) return false;
      const [a, e] = pair;
      if (operator === "GREATER_THAN") return a > e;
      if (operator === "GREATER_THAN_OR_EQUAL") return a >= e;
      if (operator === "LESS_THAN") return a < e;
      return a <= e;
    }
    default:
      return false;
  }
}

/**
 * Evaluates a condition tree against `context`. A null/undefined condition means
 * "always applies". Malformed nodes evaluate to false rather than throwing, since
 * conditions are validated on write but snapshots may predate newer validation.
 */
export function evaluateCondition(raw: unknown, context: unknown, depth = 0): boolean {
  if (raw === null || raw === undefined) return true;
  if (depth > MAX_DEPTH || typeof raw !== "object" || Array.isArray(raw)) return false;
  const node = raw as Record<string, unknown>;
  if ("all" in node) {
    return Array.isArray(node.all) && node.all.every((c) => evaluateCondition(c, context, depth + 1));
  }
  if ("any" in node) {
    return Array.isArray(node.any) && node.any.some((c) => evaluateCondition(c, context, depth + 1));
  }
  if ("not" in node) {
    return node.not !== null && node.not !== undefined && !evaluateCondition(node.not, context, depth + 1);
  }
  if (typeof node.field !== "string" || typeof node.operator !== "string") return false;
  if (!(CONDITION_OPERATORS as readonly string[]).includes(node.operator)) return false;
  return compare(node.operator as ConditionOperator, resolvePath(context, node.field), node.value);
}
