// Pure condition language for SOPs: no Prisma, no I/O, so it's trivially unit-testable.
//
// A condition is a JSON tree:
//   { all: Condition[] } | { any: Condition[] } | { not: Condition }
//   | { field: "<root>.<path>", operator: Operator, value?: unknown }
//
// `field` is a dotted path into the execution context (see SOP_CONTEXT_ROOTS), e.g.
// "issue.type", "fields.riskLevel", "entity.name", "steps.qa_testing.result",
// "trigger.stepKey". Nothing user-provided is ever executed — only compared.

export const SOP_CONTEXT_ROOTS = [
  "subject", // { type: ISSUE | NOTE | TASK, id }
  "issue", // the work item's tracker fields (also populated for notes and tasks)
  "note",
  "task",
  "entity", // the owning entity: component / project, or the note's top-level module
  "parent", // a note's direct parent
  "fields", // custom fields
  "steps", // steps.<key>.{status,result,output,notes,approvals,completedById}
  "execution", // { status, assignmentType, sopVersion }
  "trigger", // only while rules run: { type, stepKey, stepType }
] as const;

export const SOP_OPERATORS = [
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
  "EXISTS",
  "NOT_EXISTS",
] as const;

export type SopOperator = (typeof SOP_OPERATORS)[number];

/** Operators that don't take a `value`. */
export const UNARY_OPERATORS: readonly SopOperator[] = ["EXISTS", "NOT_EXISTS"];

export const FIELD_PATH_PATTERN = new RegExp(
  `^(${SOP_CONTEXT_ROOTS.join("|")})(\\.[A-Za-z0-9_-]{1,64}){1,4}$`
);

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { field: string; operator: SopOperator; value?: unknown };

export type SopContext = Record<string, unknown>;

const MAX_DEPTH = 12;

/** Reads a dotted path; own properties only, so "__proto__"-style paths resolve to undefined. */
export function readPath(context: SopContext, path: string): unknown {
  let current: unknown = context;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function equals(a: unknown, b: unknown) {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function contains(actual: unknown, expected: unknown) {
  if (Array.isArray(actual)) return actual.some((item) => equals(item, expected));
  return typeof actual === "string" && typeof expected === "string" && actual.toLowerCase().includes(expected.toLowerCase());
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

const toNumber = (value: unknown) =>
  typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;

/** Numbers (or numeric strings) compare numerically; ISO date strings compare by time. */
function compare(actual: unknown, expected: unknown): number | null {
  const na = toNumber(actual);
  const nb = toNumber(expected);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  if (typeof actual === "string" && typeof expected === "string" && ISO_DATE.test(actual) && ISO_DATE.test(expected)) {
    const a = Date.parse(actual);
    const b = Date.parse(expected);
    if (!Number.isNaN(a) && !Number.isNaN(b)) return a - b;
  }
  return null;
}

/**
 * Evaluates a condition tree against `context`. A null/undefined condition always
 * matches (a step or rule without a condition always applies). Malformed nodes and
 * unknown operators evaluate to false rather than throwing.
 * String comparisons (EQUALS / CONTAINS / IN) are case-insensitive.
 */
export function evaluateCondition(raw: unknown, context: SopContext): boolean {
  if (raw === null || raw === undefined) return true;
  try {
    return evaluateNode(raw, context, 0);
  } catch (error) {
    // Too deep: fail the whole condition (a subtree returning false could be negated by `not`).
    if (error === TOO_DEEP) return false;
    throw error;
  }
}

const TOO_DEEP = Symbol("condition too deep");

function evaluateNode(raw: unknown, context: SopContext, depth: number): boolean {
  if (depth > MAX_DEPTH) throw TOO_DEEP;
  if (!isPlainObject(raw)) return false;

  if ("all" in raw) return Array.isArray(raw.all) && raw.all.every((child) => evaluateNode(child, context, depth + 1));
  if ("any" in raw) return Array.isArray(raw.any) && raw.any.some((child) => evaluateNode(child, context, depth + 1));
  if ("not" in raw) return raw.not !== undefined && raw.not !== null && !evaluateNode(raw.not, context, depth + 1);

  const { field, operator, value: expected } = raw as { field?: unknown; operator?: unknown; value?: unknown };
  if (typeof field !== "string" || !FIELD_PATH_PATTERN.test(field) || typeof operator !== "string") return false;
  const actual = readPath(context, field);
  const present = actual !== null && actual !== undefined && !(Array.isArray(actual) && actual.length === 0) && actual !== "";

  switch (operator as SopOperator) {
    case "EXISTS":
      return present;
    case "NOT_EXISTS":
      return !present;
    case "EQUALS":
      return equals(actual, expected);
    case "NOT_EQUALS":
      return !equals(actual, expected);
    case "CONTAINS":
      return contains(actual, expected);
    case "NOT_CONTAINS":
      return !contains(actual, expected);
    case "IN":
      return Array.isArray(expected) && (Array.isArray(actual)
        ? actual.some((item) => expected.some((e) => equals(item, e)))
        : expected.some((e) => equals(actual, e)));
    case "NOT_IN":
      return Array.isArray(expected) && (Array.isArray(actual)
        ? !actual.some((item) => expected.some((e) => equals(item, e)))
        : !expected.some((e) => equals(actual, e)));
    case "GREATER_THAN": {
      const c = compare(actual, expected);
      return c !== null && c > 0;
    }
    case "GREATER_THAN_OR_EQUAL": {
      const c = compare(actual, expected);
      return c !== null && c >= 0;
    }
    case "LESS_THAN": {
      const c = compare(actual, expected);
      return c !== null && c < 0;
    }
    case "LESS_THAN_OR_EQUAL": {
      const c = compare(actual, expected);
      return c !== null && c <= 0;
    }
    default:
      return false;
  }
}

/** Every `field` referenced anywhere in a condition tree. */
export function conditionFields(raw: unknown, depth = 0): string[] {
  if (depth > MAX_DEPTH || !isPlainObject(raw)) return [];
  if (Array.isArray(raw.all)) return raw.all.flatMap((c) => conditionFields(c, depth + 1));
  if (Array.isArray(raw.any)) return raw.any.flatMap((c) => conditionFields(c, depth + 1));
  if ("not" in raw) return conditionFields(raw.not, depth + 1);
  return typeof raw.field === "string" ? [raw.field] : [];
}

/**
 * Resolves a step's effective config at activation time: the base config, then each
 * entry of `config.overrides` (`[{ when: Condition, set: {...} }]`) whose `when`
 * matches is shallow-merged on top, in order. This is how "IF risk = HIGH → 2
 * approvals" is expressed without code:
 *   { requiredApprovals: 1, overrides: [{ when: {field:"fields.riskLevel",operator:"EQUALS",value:"HIGH"}, set: { requiredApprovals: 2 } }] }
 */
export function resolveStepConfig(raw: unknown, context: SopContext): Record<string, unknown> {
  if (!isPlainObject(raw)) return {};
  const { overrides, ...base } = raw;
  const resolved: Record<string, unknown> = { ...base };
  if (Array.isArray(overrides)) {
    for (const override of overrides) {
      if (isPlainObject(override) && isPlainObject(override.set) && evaluateCondition(override.when, context)) {
        Object.assign(resolved, override.set);
      }
    }
  }
  return resolved;
}

/** Lower-snake-case key from a title, deduped against `taken` (step_2, step_3, …). */
export function slugifyKey(title: string, taken: Iterable<string>): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "step";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
