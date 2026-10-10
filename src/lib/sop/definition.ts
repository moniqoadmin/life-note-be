import type { Prisma, SopRule, SopStep, SopStepType } from "@prisma/client";
import { conditionFields } from "@/lib/sop/conditions";
import { parseStepConfig, sopActionSchema, type SopAction } from "@/lib/validation";

type Db = Prisma.TransactionClient;

// The frozen shape of an SOP that executions run. Stored in SopVersion.definition
// (published) and copied into every execution's definitionSnapshot, so neither later
// edits nor publishing a new version ever changes an in-flight execution.
export type StepDefinition = {
  key: string;
  position: number;
  title: string;
  description: string;
  command: string | null;
  requiresSignoff: boolean;
  type: SopStepType;
  config: Record<string, unknown>;
  condition: unknown;
};

export type RuleDefinition = {
  id: string;
  name: string;
  trigger: string;
  condition: unknown;
  actions: SopAction[];
  enabled: boolean;
};

export type SopDefinition = {
  sopId: string;
  title: string;
  version: number;
  steps: StepDefinition[];
  rules: RuleDefinition[];
};

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Rules were stored with a single `action` before v2; both shapes normalize to `actions`. */
export function normalizeActions(raw: unknown): SopAction[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.flatMap((item) => {
    const parsed = sopActionSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Pre-v2 trigger names map to their v2 equivalents. */
export const normalizeTrigger = (trigger: string) =>
  trigger === "ISSUE_STATUS_CHANGED" ? "SUBJECT_STATUS_CHANGED" : trigger;

export function buildDefinition(sop: { id: string; title: string; version: number }, steps: SopStep[], rules: SopRule[]): SopDefinition {
  return {
    sopId: sop.id,
    title: sop.title,
    version: sop.version,
    steps: [...steps]
      .sort((a, b) => a.position - b.position)
      .map((step, index) => ({
        key: step.key,
        position: index,
        title: step.title,
        description: step.description,
        command: step.command,
        requiresSignoff: step.requiresSignoff,
        type: step.type,
        config: asObject(step.config),
        condition: step.condition ?? null,
      })),
    rules: rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      trigger: normalizeTrigger(rule.trigger),
      condition: rule.condition ?? null,
      actions: normalizeActions(rule.action),
      enabled: rule.enabled,
    })),
  };
}

/** The definition new executions should run: latest published version, else the live draft. */
export async function loadRunnableDefinition(db: Db, sopId: string): Promise<{ definition: SopDefinition; published: boolean } | null> {
  const sop = await db.sop.findUnique({
    where: { id: sopId },
    include: { steps: { orderBy: { position: "asc" } }, rules: { orderBy: { createdAt: "asc" } } },
  });
  if (!sop) return null;
  if (sop.publishedVersion !== null) {
    const version = await db.sopVersion.findUnique({ where: { sopId_version: { sopId, version: sop.publishedVersion } } });
    if (version) return { definition: { ...(version.definition as SopDefinition), title: sop.title }, published: true };
  }
  return { definition: buildDefinition(sop, sop.steps, sop.rules), published: false };
}

/**
 * Static checks run before publishing: every step config valid for its type, and
 * every step key referenced by a GOTO / SKIP / branch / `steps.<key>` condition
 * exists. Returns human-readable problems; empty means publishable.
 */
export function validateDefinition(definition: SopDefinition): string[] {
  const problems: string[] = [];
  const keys = new Set(definition.steps.map((s) => s.key));
  if (definition.steps.length === 0) problems.push("An SOP needs at least one step");

  const checkFields = (where: string, condition: unknown) => {
    for (const field of conditionFields(condition)) {
      const [root, key] = field.split(".");
      if (root === "steps" && !keys.has(key)) problems.push(`${where} references unknown step "${key}"`);
    }
  };
  const checkAction = (where: string, action: SopAction) => {
    if ((action.type === "GOTO_STEP" || action.type === "SKIP_STEP") && !keys.has(action.stepKey)) {
      problems.push(`${where}: ${action.type} targets unknown step "${action.stepKey}"`);
    }
  };

  for (const step of definition.steps) {
    const where = `Step ${step.position + 1} ("${step.title}")`;
    const parsed = parseStepConfig(step.type, step.config);
    if (!parsed.success) {
      problems.push(`${where}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "config"} — ${i.message}`).join("; ")}`);
      continue;
    }
    const config = parsed.data;
    checkFields(where, step.condition);
    for (const goto of [config.onTrueGoto, config.onFalseGoto]) {
      if (typeof goto === "string" && !keys.has(goto)) problems.push(`${where} branches to unknown step "${goto}"`);
    }
    if (config.check) checkFields(where, config.check);
    if (config.action) checkAction(where, config.action as SopAction);
    if (Array.isArray(config.overrides)) config.overrides.forEach((o) => checkFields(where, (o as { when: unknown }).when));
  }
  for (const rule of definition.rules) {
    const where = `Rule "${rule.name}"`;
    checkFields(where, rule.condition);
    if (rule.actions.length === 0) problems.push(`${where} has no valid actions`);
    rule.actions.forEach((action) => checkAction(where, action));
  }
  return problems;
}

/** Step keys of a snapshot; executions created before keys existed fall back to step_<n>. */
export const stepKeyOf = (step: { key: string | null; position: number }) => step.key ?? `step_${step.position + 1}`;

export function snapshotOf(raw: Prisma.JsonValue): SopDefinition {
  const snap = asObject(raw);
  const steps = Array.isArray(snap.steps) ? (snap.steps as Record<string, unknown>[]) : [];
  const rules = Array.isArray(snap.rules) ? (snap.rules as Record<string, unknown>[]) : [];
  return {
    sopId: String(snap.sopId ?? snap.id ?? ""),
    title: String(snap.title ?? ""),
    version: Number(snap.version ?? 0),
    steps: steps.map((s, index) => ({
      key: typeof s.key === "string" ? s.key : `step_${(typeof s.position === "number" ? s.position : index) + 1}`,
      position: typeof s.position === "number" ? s.position : index,
      title: String(s.title ?? ""),
      description: String(s.description ?? ""),
      command: typeof s.command === "string" ? s.command : null,
      requiresSignoff: !!s.requiresSignoff,
      type: (s.type as SopStepType) ?? "INSTRUCTION",
      config: asObject(s.config),
      condition: s.condition ?? null,
    })),
    rules: rules.map((r) => ({
      id: String(r.id ?? ""),
      name: String(r.name ?? ""),
      trigger: normalizeTrigger(String(r.trigger ?? "")),
      condition: r.condition ?? null,
      actions: normalizeActions(r.actions ?? r.action),
      enabled: r.enabled !== false,
    })),
  };
}
