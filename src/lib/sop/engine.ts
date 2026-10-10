import { randomBytes } from "node:crypto";
import { Prisma, type RunbookMode, type RunbookStep, type SopAssignmentType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { evaluateCondition, resolveStepConfig, type SopContext } from "@/lib/sop/conditions";
import { loadRunnableDefinition, snapshotOf, stepKeyOf, type RuleDefinition } from "@/lib/sop/definition";
import {
  SUBJECT_ADAPTERS,
  SUBJECT_COLUMN,
  subjectOf,
  subjectWhere,
  type Resolution,
  type SubjectRef,
} from "@/lib/sop/subjects";
import type { RunbookStepUpdate, SopAction } from "@/lib/validation";

// =============================================================================
// SOP execution engine.
//
// Every public entry point runs inside the caller's transaction and starts by
// locking the execution row (SELECT … FOR UPDATE), then re-reads state — so two
// people completing the same step at the same moment serialize instead of both
// advancing the run. Steps are activated lazily: a step's `condition` is evaluated
// only when the run reaches it, against the subject as it is *then*.
// =============================================================================

type Db = Prisma.TransactionClient;

/** Interactive-transaction options for anything that drives the engine. */
export const ENGINE_TX = { timeout: 20_000, maxWait: 10_000 } as const;

export class SopEngineError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, message: string) {
    super(message);
  }
}

/**
 * Per-request budget shared by everything one call triggers, so a misconfigured SOP
 * (a rule that GOTOs into a step whose start fires the same rule, a CONDITION loop…)
 * blocks the run with an explanation instead of spinning forever.
 */
type Run = { actorId: string | null; budget: number; ruleDepth: number };
const newRun = (actorId: string | null): Run => ({ actorId, budget: 200, ruleDepth: 0 });
const MAX_RULE_DEPTH = 5;

const ACTIVE_STATUSES = ["PENDING", "IN_PROGRESS", "BLOCKED", "FAILED"] as const;
const FINISHED = (status: string) => status === "VERIFIED" || status === "SKIPPED";

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const stepLabel = (step: RunbookStep) => `Step ${step.position + 1} ("${step.title}")`;

// -----------------------------------------------------------------------------
// Loading, locking, context
// -----------------------------------------------------------------------------

async function lockExecution(db: Db, executionId: string) {
  await db.$queryRaw`SELECT "id" FROM "issue_runbooks" WHERE "id" = ${executionId} FOR UPDATE`;
}

async function loadExecution(db: Db, executionId: string) {
  return db.issueRunbook.findUniqueOrThrow({
    where: { id: executionId },
    include: { steps: { orderBy: { position: "asc" }, include: { approvals: { select: { userId: true, decision: true } } } } },
  });
}
type LoadedExecution = Awaited<ReturnType<typeof loadExecution>>;

export async function recordEvent(
  db: Db,
  executionId: string,
  actorId: string | null,
  type: string,
  data: Prisma.InputJsonObject = {}
) {
  await db.runbookEvent.create({ data: { runbookId: executionId, actorId, type, data } });
}

/** The full condition context for an execution: subject + steps + execution (+ trigger). */
export async function buildContext(db: Db, execution: LoadedExecution, trigger?: SopContext): Promise<SopContext> {
  const subject = subjectOf(execution);
  const base = await SUBJECT_ADAPTERS[subject.type].loadContext(db, subject.id);
  const steps: Record<string, unknown> = {};
  for (const step of execution.steps) {
    steps[stepKeyOf(step)] = {
      status: step.status,
      type: step.type,
      result: step.result,
      output: step.output,
      notes: step.notes,
      completedById: step.completedById,
      approvals: step.approvals.filter((a) => a.decision === "APPROVED").length,
      rejections: step.approvals.filter((a) => a.decision === "REJECTED").length,
    };
  }
  return {
    ...base,
    steps,
    execution: {
      id: execution.id,
      status: execution.status,
      assignmentType: execution.assignmentType ?? "MANUAL",
      sopId: execution.sopId,
      sopVersion: execution.sopVersion,
    },
    ...(trigger && { trigger }),
  };
}

function baseConfigOf(execution: LoadedExecution, step: RunbookStep) {
  const snapshot = snapshotOf(execution.definitionSnapshot);
  const key = stepKeyOf(step);
  return snapshot.steps.find((s) => s.key === key)?.config ?? asObject(step.config);
}

const isExternal = (step: RunbookStep, config: Record<string, unknown>) =>
  step.type === "GITHUB_ACTION" || (step.type === "AUTOMATED_ACTION" && !config.action);

// -----------------------------------------------------------------------------
// Creating executions and resolving which SOP a subject runs
// -----------------------------------------------------------------------------

export async function resolveSubjectSop(db: Db, subject: SubjectRef): Promise<Resolution | null> {
  const adapter = SUBJECT_ADAPTERS[subject.type];
  const context = await adapter.loadContext(db, subject.id);
  const resolution = await adapter.resolve(db, subject.id, context);
  if (!resolution) return null;
  // A stale override / assignment pointing at an SOP the subject may not use is ignored.
  return (await adapter.canUseSop(db, subject.id, resolution.sopId)) ? resolution : null;
}

export async function createExecution(
  db: Db,
  subject: SubjectRef,
  sopId: string,
  options: { assignmentType: SopAssignmentType; actorId: string | null; mode?: RunbookMode; source?: Resolution["source"] }
) {
  const loaded = await loadRunnableDefinition(db, sopId);
  if (!loaded) throw new SopEngineError(404, "SOP not found");
  const { definition, published } = loaded;
  if (definition.steps.length === 0) throw new SopEngineError(400, "This SOP has no steps to run");

  const execution = await db.issueRunbook.create({
    data: {
      ...subjectWhere(subject),
      sopId,
      sopVersion: definition.version,
      title: definition.title,
      mode: options.mode ?? "MANUAL",
      status: "IN_PROGRESS",
      assignmentType: options.assignmentType,
      definitionSnapshot: definition as unknown as Prisma.InputJsonObject,
      steps: {
        create: definition.steps.map((step, index) => ({
          key: step.key,
          position: index,
          title: step.title,
          description: step.description,
          command: step.command,
          requiresSignoff: step.requiresSignoff,
          type: step.type,
          config: step.config as Prisma.InputJsonObject,
          ...(step.condition !== null && { condition: step.condition as Prisma.InputJsonValue }),
        })),
      },
    },
  });
  await recordEvent(db, execution.id, options.actorId, "EXECUTION_CREATED", {
    sopId,
    sopVersion: definition.version,
    published,
    assignmentType: options.assignmentType,
    ...(options.source && { source: options.source as unknown as Prisma.InputJsonObject }),
  });
  const run = newRun(options.actorId);
  await applyRules(db, execution.id, "EXECUTION_STARTED", run);
  await advance(db, execution.id, 0, run);
  return execution.id;
}

/** Manually attach an SOP to a subject (assignmentType MANUAL). */
export async function attachExecution(db: Db, subject: SubjectRef, sopId: string, actorId: string, mode: RunbookMode = "MANUAL") {
  if (!(await SUBJECT_ADAPTERS[subject.type].canUseSop(db, subject.id, sopId, actorId))) {
    throw new SopEngineError(404, "SOP not found");
  }
  return createExecution(db, subject, sopId, { assignmentType: "MANUAL", actorId, mode });
}

/**
 * Makes the subject's automatically-assigned execution match what it should run now
 * (override → entity default → none). Leaves a matching run alone — including its
 * progress — so re-saving a field or moving within the same entity never restarts it.
 * A run for a different SOP is cancelled (kept for history) and a new one started.
 */
export async function syncAssignedExecution(db: Db, subject: SubjectRef, actorId: string | null) {
  const resolution = await resolveSubjectSop(db, subject);
  const current = await db.issueRunbook.findFirst({
    where: { ...subjectWhere(subject), assignmentType: { in: ["ENTITY_INHERITED", "TASK_OVERRIDE"] }, NOT: { status: "SKIPPED" } },
    orderBy: { createdAt: "desc" },
  });

  if (current && resolution && current.sopId === resolution.sopId) {
    if (current.assignmentType !== resolution.assignmentType) {
      await db.issueRunbook.update({ where: { id: current.id }, data: { assignmentType: resolution.assignmentType } });
      await recordEvent(db, current.id, actorId, "ASSIGNMENT_CHANGED", {
        assignmentType: resolution.assignmentType,
        source: resolution.source as unknown as Prisma.InputJsonObject,
      });
    }
    return { executionId: current.id, changed: false };
  }
  if (current && (ACTIVE_STATUSES as readonly string[]).includes(current.status)) {
    await lockExecution(db, current.id);
    await cancelExecution(db, current.id, actorId, resolution ? "SOP_REASSIGNED" : "SOP_UNASSIGNED");
  }
  if (!resolution) return { executionId: null, changed: !!current };
  const executionId = await createExecution(db, subject, resolution.sopId, {
    assignmentType: resolution.assignmentType,
    actorId,
    source: resolution.source,
  });
  return { executionId, changed: true };
}

async function cancelExecution(db: Db, executionId: string, actorId: string | null, reason: string) {
  await db.runbookStep.updateMany({
    where: { runbookId: executionId, status: { in: ["PENDING", "IN_PROGRESS", "BLOCKED", "FAILED"] } },
    data: { status: "SKIPPED", completedAt: new Date(), callbackToken: null },
  });
  await db.issueRunbook.update({ where: { id: executionId }, data: { status: "SKIPPED", currentStepId: null } });
  await recordEvent(db, executionId, actorId, "EXECUTION_CANCELLED", { reason });
}

// -----------------------------------------------------------------------------
// Moving through steps
// -----------------------------------------------------------------------------

/**
 * Starts the next applicable step at or after `fromPosition`: skips steps whose
 * condition is false, resolves conditional config, then auto-runs CONDITION and
 * internal AUTOMATED_ACTION steps. Completes the execution when nothing is left.
 */
async function advance(db: Db, executionId: string, fromPosition: number, run: Run): Promise<void> {
  let position = fromPosition;
  for (;;) {
    if (--run.budget < 0) return haltForLoop(db, executionId, run);
    const execution = await loadExecution(db, executionId);
    if (execution.status !== "IN_PROGRESS" && execution.status !== "PENDING") return;

    const next = execution.steps.find((s) => s.position >= position && s.status === "PENDING");
    if (!next) {
      await db.issueRunbook.update({
        where: { id: executionId },
        data: { status: "COMPLETED", currentStepId: null, completedAt: new Date() },
      });
      await recordEvent(db, executionId, run.actorId, "EXECUTION_COMPLETED");
      await applyRules(db, executionId, "EXECUTION_COMPLETED", run);
      return;
    }

    const context = await buildContext(db, execution);
    if (!evaluateCondition(next.condition, context)) {
      await db.runbookStep.update({
        where: { id: next.id },
        data: { status: "SKIPPED", completedAt: new Date(), executor: "condition" },
      });
      await recordEvent(db, executionId, run.actorId, "STEP_SKIPPED", {
        stepId: next.id, key: stepKeyOf(next), title: next.title, reason: "CONDITION_FALSE",
      });
      position = next.position + 1;
      continue;
    }

    const config = resolveStepConfig(baseConfigOf(execution, next), context);
    await db.runbookStep.update({
      where: { id: next.id },
      data: {
        status: "IN_PROGRESS",
        startedAt: new Date(),
        config: config as Prisma.InputJsonObject,
        callbackToken: isExternal(next, config) ? randomBytes(24).toString("base64url") : null,
      },
    });
    await db.issueRunbook.update({ where: { id: executionId }, data: { status: "IN_PROGRESS", currentStepId: next.id } });
    await recordEvent(db, executionId, run.actorId, "STEP_STARTED", { stepId: next.id, key: stepKeyOf(next), title: next.title });
    await applyRules(db, executionId, "STEP_STARTED", run, next);
    if (!(await isCurrent(db, executionId, next.id))) return;

    if (next.type === "CONDITION") return runConditionStep(db, executionId, next.id, config, run);
    if (next.type === "AUTOMATED_ACTION" && config.action) {
      const parsed = config.action as SopAction;
      await executeAction(db, executionId, parsed, run, { stepId: next.id });
      if (!(await isCurrent(db, executionId, next.id))) return;
      return completeStep(db, executionId, next.id, run, { executor: "automation", output: `Ran ${parsed.type}` });
    }
    return; // waits for a person, an approval or an external callback
  }
}

async function isCurrent(db: Db, executionId: string, stepId: string) {
  const execution = await db.issueRunbook.findUniqueOrThrow({ where: { id: executionId }, select: { status: true, currentStepId: true } });
  return execution.currentStepId === stepId && (execution.status === "IN_PROGRESS" || execution.status === "PENDING");
}

async function haltForLoop(db: Db, executionId: string, run: Run) {
  await db.issueRunbook.update({ where: { id: executionId }, data: { status: "BLOCKED" } });
  await recordEvent(db, executionId, run.actorId, "EXECUTION_BLOCKED", {
    reason: "LOOP_GUARD",
    message: "Stopped: this SOP's rules/branches kept re-triggering each other. Check GOTO_STEP rules and CONDITION branches.",
  });
}

async function runConditionStep(db: Db, executionId: string, stepId: string, config: Record<string, unknown>, run: Run) {
  const execution = await loadExecution(db, executionId);
  const passed = evaluateCondition(config.check ?? null, await buildContext(db, execution));
  await db.runbookStep.update({ where: { id: stepId }, data: { result: passed ? "TRUE" : "FALSE" } });
  const goto = passed ? config.onTrueGoto : config.onFalseGoto;
  if (passed || typeof goto === "string" || config.onFalse === "CONTINUE") {
    await completeStep(db, executionId, stepId, run, {
      executor: "condition",
      output: passed ? "Condition met" : "Condition not met",
      advance: typeof goto !== "string",
    });
    if (typeof goto === "string" && (await stillOwns(db, executionId, stepId))) await gotoStep(db, executionId, goto, run, "BRANCH");
    return;
  }
  if (config.onFalse === "BLOCK") return blockStep(db, executionId, stepId, run, "Condition not met");
  return failStep(db, executionId, stepId, run, { output: "Condition not met" });
}

/** True while rules haven't moved the run elsewhere since `stepId` finished. */
async function stillOwns(db: Db, executionId: string, stepId: string) {
  const execution = await db.issueRunbook.findUniqueOrThrow({ where: { id: executionId }, select: { status: true, currentStepId: true } });
  return execution.currentStepId === stepId && !["SKIPPED", "COMPLETED"].includes(execution.status);
}

async function completeStep(
  db: Db,
  executionId: string,
  stepId: string,
  run: Run,
  extra: { executor?: string | null; output?: string; notes?: string; advance?: boolean } = {}
) {
  const step = await db.runbookStep.update({
    where: { id: stepId },
    data: {
      status: "VERIFIED",
      completedAt: new Date(),
      completedById: run.actorId,
      callbackToken: null,
      ...(extra.executor !== undefined && { executor: extra.executor }),
      ...(extra.output !== undefined && { output: extra.output }),
      ...(extra.notes !== undefined && { notes: extra.notes }),
    },
  });
  await recordEvent(db, executionId, run.actorId, "STEP_COMPLETED", {
    stepId, key: stepKeyOf(step), title: step.title,
    ...(extra.executor && { executor: extra.executor }),
    ...(extra.output && { output: extra.output }),
    ...(step.notes && { notes: step.notes }),
  });
  await applyRules(db, executionId, "STEP_COMPLETED", run, step);
  if (extra.advance !== false && (await stillOwns(db, executionId, stepId))) {
    await advance(db, executionId, step.position + 1, run);
  }
}

async function failStep(db: Db, executionId: string, stepId: string, run: Run, extra: { output?: string; notes?: string; result?: string } = {}) {
  const step = await db.runbookStep.update({
    where: { id: stepId },
    data: {
      status: "FAILED",
      completedAt: new Date(),
      completedById: run.actorId,
      callbackToken: null,
      ...(extra.output !== undefined && { output: extra.output }),
      ...(extra.notes !== undefined && { notes: extra.notes }),
      ...(extra.result !== undefined && { result: extra.result }),
    },
  });
  await db.issueRunbook.update({ where: { id: executionId }, data: { status: "FAILED", currentStepId: stepId } });
  await recordEvent(db, executionId, run.actorId, "STEP_FAILED", {
    stepId, key: stepKeyOf(step), title: step.title,
    ...(extra.output && { output: extra.output }),
    ...(extra.notes && { notes: extra.notes }),
  });
  await applyRules(db, executionId, "STEP_FAILED", run, step);
}

async function blockStep(db: Db, executionId: string, stepId: string, run: Run, reason?: string) {
  const step = await db.runbookStep.update({ where: { id: stepId }, data: { status: "BLOCKED" } });
  await db.issueRunbook.update({ where: { id: executionId }, data: { status: "BLOCKED", currentStepId: stepId } });
  await recordEvent(db, executionId, run.actorId, "STEP_BLOCKED", {
    stepId, key: stepKeyOf(step), title: step.title, ...(reason && { reason }),
  });
  await applyRules(db, executionId, "STEP_BLOCKED", run, step);
}

async function skipStep(db: Db, executionId: string, stepId: string, run: Run, reason: string) {
  const step = await db.runbookStep.update({
    where: { id: stepId },
    data: { status: "SKIPPED", completedAt: new Date(), completedById: run.actorId, callbackToken: null },
  });
  await recordEvent(db, executionId, run.actorId, "STEP_SKIPPED", { stepId, key: stepKeyOf(step), title: step.title, reason });
  await applyRules(db, executionId, "STEP_SKIPPED", run, step);
  const execution = await db.issueRunbook.findUniqueOrThrow({ where: { id: executionId }, select: { currentStepId: true, status: true } });
  if (execution.currentStepId === stepId) {
    await db.issueRunbook.update({ where: { id: executionId }, data: { status: "IN_PROGRESS" } });
    await advance(db, executionId, step.position + 1, run);
  }
}

async function retryStep(db: Db, executionId: string, step: RunbookStep, run: Run) {
  const config = asObject(step.config); // already resolved when the step first started
  await db.runbookStep.update({
    where: { id: step.id },
    data: {
      status: "IN_PROGRESS",
      completedAt: null,
      completedById: null,
      result: null,
      callbackToken: isExternal(step, config) ? randomBytes(24).toString("base64url") : null,
    },
  });
  if (step.type === "APPROVAL") await db.runbookApproval.deleteMany({ where: { stepId: step.id } });
  await db.issueRunbook.update({ where: { id: executionId }, data: { status: "IN_PROGRESS", currentStepId: step.id, completedAt: null } });
  await recordEvent(db, executionId, run.actorId, "STEP_RETRIED", { stepId: step.id, key: stepKeyOf(step), title: step.title, from: step.status });
  if (step.type === "CONDITION") return runConditionStep(db, executionId, step.id, config, run);
}

/** Resets `key` and every later step, then re-runs from there ("send back to Development"). */
async function gotoStep(db: Db, executionId: string, key: string, run: Run, reason: string) {
  const execution = await loadExecution(db, executionId);
  const target = execution.steps.find((s) => stepKeyOf(s) === key);
  if (!target) {
    await recordEvent(db, executionId, run.actorId, "GOTO_TARGET_MISSING", { key });
    return;
  }
  const resetIds = execution.steps.filter((s) => s.position >= target.position).map((s) => s.id);
  await db.runbookApproval.deleteMany({ where: { stepId: { in: resetIds } } });
  await db.runbookStep.updateMany({
    where: { id: { in: resetIds } },
    data: {
      status: "PENDING", completedAt: null, completedById: null, startedAt: null, executor: null,
      notes: "", output: "", result: null, data: {}, callbackToken: null,
    },
  });
  await db.issueRunbook.update({ where: { id: executionId }, data: { status: "IN_PROGRESS", currentStepId: null, completedAt: null } });
  await recordEvent(db, executionId, run.actorId, "EXECUTION_REWOUND", { toStepId: target.id, key, title: target.title, reason });
  await advance(db, executionId, target.position, run);
}

// -----------------------------------------------------------------------------
// Rules and actions
// -----------------------------------------------------------------------------

async function applyRules(db: Db, executionId: string, trigger: string, run: Run, step?: RunbookStep) {
  const execution = await loadExecution(db, executionId);
  const rules = snapshotOf(execution.definitionSnapshot).rules.filter((r) => r.enabled && r.trigger === trigger);
  if (rules.length === 0) return;
  if (run.ruleDepth >= MAX_RULE_DEPTH) {
    await recordEvent(db, executionId, run.actorId, "RULES_SKIPPED", { trigger, reason: "MAX_DEPTH" });
    return;
  }
  const context = await buildContext(db, execution, {
    type: trigger,
    ...(step && { stepKey: stepKeyOf(step), stepType: step.type, stepId: step.id }),
  });
  const matching = rules.filter((rule) => evaluateCondition(rule.condition, context));
  for (const rule of matching) await fireRule(db, executionId, rule, trigger, run);
}

async function fireRule(db: Db, executionId: string, rule: RuleDefinition, trigger: string, run: Run) {
  await recordEvent(db, executionId, run.actorId, "RULE_EXECUTED", {
    ruleId: rule.id, name: rule.name, trigger, actions: rule.actions as unknown as Prisma.InputJsonArray,
  });
  run.ruleDepth++;
  try {
    for (const action of rule.actions) await executeAction(db, executionId, action, run, { ruleId: rule.id });
  } finally {
    run.ruleDepth--;
  }
}

async function executeAction(db: Db, executionId: string, action: SopAction, run: Run, origin: { ruleId?: string; stepId?: string }) {
  const execution = await loadExecution(db, executionId);
  const subject = subjectOf(execution);
  const adapter = SUBJECT_ADAPTERS[subject.type];
  const ignore = (reason: string) =>
    recordEvent(db, executionId, run.actorId, "ACTION_IGNORED", { type: action.type, reason, ...origin });

  switch (action.type) {
    case "SET_SUBJECT_STATUS":
    case "SET_ISSUE_STATUS": {
      if (!adapter.statuses.includes(action.status)) return ignore(`${subject.type} can't be ${action.status}`);
      await adapter.setStatus(db, subject.id, action.status);
      break;
    }
    case "SET_RUNBOOK_STATUS": {
      if (action.status === "SKIPPED") {
        await cancelExecution(db, executionId, run.actorId, "RULE");
      } else {
        await db.issueRunbook.update({ where: { id: executionId }, data: { status: action.status } });
      }
      break;
    }
    case "GOTO_STEP":
      await gotoStep(db, executionId, action.stepKey, run, origin.ruleId ? "RULE" : "AUTOMATION");
      return;
    case "SKIP_STEP": {
      const target = execution.steps.find((s) => stepKeyOf(s) === action.stepKey);
      if (!target) return ignore(`Unknown step ${action.stepKey}`);
      if (FINISHED(target.status)) return ignore(`Step ${action.stepKey} already finished`);
      if (execution.currentStepId === target.id) await skipStep(db, executionId, target.id, run, "RULE");
      else {
        await db.runbookStep.update({ where: { id: target.id }, data: { status: "SKIPPED", completedAt: new Date(), executor: "rule" } });
        await recordEvent(db, executionId, run.actorId, "STEP_SKIPPED", { stepId: target.id, key: action.stepKey, title: target.title, reason: "RULE" });
      }
      return;
    }
    case "ADD_LABEL":
    case "REMOVE_LABEL": {
      const context = await adapter.loadContext(db, subject.id);
      const labels = (asObject(context.issue).labels as string[] | undefined) ?? [];
      const has = labels.some((l) => l.toLowerCase() === action.label.toLowerCase());
      if (action.type === "ADD_LABEL" && !has) await adapter.setLabels(db, subject.id, [...labels, action.label]);
      if (action.type === "REMOVE_LABEL" && has) {
        await adapter.setLabels(db, subject.id, labels.filter((l) => l.toLowerCase() !== action.label.toLowerCase()));
      }
      break;
    }
    case "SET_FIELD":
      await adapter.setField(db, subject.id, action.field, action.value as Prisma.InputJsonValue | null);
      break;
    case "NOTIFY": {
      const recipients = (await adapter.recipients(db, subject.id, action.recipients, action.userIds)).filter((id) => id !== run.actorId);
      if (recipients.length > 0) {
        const info = await adapter.describe(db, subject.id);
        await db.notification.createMany({
          data: recipients.map((userId) => ({
            userId,
            actorId: run.actorId,
            type: "SOP" as const,
            workspaceId: info.workspaceId,
            issueId: info.issueId,
            data: {
              message: action.message, executionId, subjectType: subject.type, subjectId: subject.id,
              title: info.title, key: info.key, sopTitle: execution.title,
            },
          })),
        });
      }
      break;
    }
  }
  await recordEvent(db, executionId, run.actorId, "ACTION_EXECUTED", { ...(action as unknown as Prisma.InputJsonObject), ...origin });
}

/** Fires SUBJECT_* triggers on every running execution of a subject. */
export async function notifySubjectChanged(
  db: Db,
  subject: SubjectRef,
  trigger: "SUBJECT_STATUS_CHANGED" | "SUBJECT_UPDATED",
  actorId: string | null
) {
  const executions = await db.issueRunbook.findMany({
    where: { ...subjectWhere(subject), status: { in: [...ACTIVE_STATUSES] } },
    select: { id: true },
  });
  for (const { id } of executions) {
    await lockExecution(db, id);
    await applyRules(db, id, trigger, newRun(actorId));
  }
}

// -----------------------------------------------------------------------------
// Public step operations (called from routes)
// -----------------------------------------------------------------------------

async function lockedExecution(db: Db, executionId: string) {
  await lockExecution(db, executionId);
  const execution = await loadExecution(db, executionId);
  if (execution.status === "SKIPPED") throw new SopEngineError(409, "This execution was cancelled");
  return execution;
}

/** Applies a step PATCH: notes/output/checklist edits and status transitions. */
export async function updateStep(db: Db, executionId: string, stepId: string, actorId: string, patch: RunbookStepUpdate) {
  const execution = await lockedExecution(db, executionId);
  const step = execution.steps.find((s) => s.id === stepId);
  if (!step) throw new SopEngineError(404, "Step not found");
  const run = newRun(actorId);
  const isActive = execution.currentStepId === step.id;
  const config = asObject(step.config);

  // Plain field edits.
  const data: Prisma.RunbookStepUpdateInput = {
    ...(patch.notes !== undefined && { notes: patch.notes }),
    ...(patch.output !== undefined && { output: patch.output }),
    ...(patch.executor !== undefined && { executor: patch.executor }),
  };
  if (patch.checklist) {
    if (step.type !== "CHECKLIST") throw new SopEngineError(400, "Only checklist steps have checklist items");
    if (!isActive || step.status !== "IN_PROGRESS") throw new SopEngineError(409, `${stepLabel(step)} isn't active`);
    const items = Array.isArray(config.items) ? (config.items as { key: string }[]) : [];
    const state = { ...asObject(asObject(step.data).checklist) };
    for (const [key, done] of Object.entries(patch.checklist)) {
      if (!items.some((i) => i.key === key)) throw new SopEngineError(400, `Unknown checklist item "${key}"`);
      state[key] = { done, by: actorId, at: new Date().toISOString() };
    }
    data.data = { ...asObject(step.data), checklist: state } as Prisma.InputJsonObject;
  }
  if (Object.keys(data).length > 0) await db.runbookStep.update({ where: { id: step.id }, data });
  if (patch.checklist) await recordEvent(db, executionId, actorId, "CHECKLIST_UPDATED", { stepId, items: patch.checklist });

  const fresh = await db.runbookStep.findUniqueOrThrow({ where: { id: step.id } });

  // TESTING outcome.
  if (patch.result) {
    if (step.type !== "TESTING") throw new SopEngineError(400, "Only testing steps take a result");
    if (!isActive || step.status !== "IN_PROGRESS") throw new SopEngineError(409, `${stepLabel(step)} isn't active`);
    if (patch.status && patch.status !== (patch.result === "PASSED" ? "VERIFIED" : "FAILED")) {
      throw new SopEngineError(400, "status contradicts result");
    }
    await db.runbookStep.update({ where: { id: step.id }, data: { result: patch.result } });
    if (patch.result === "PASSED") await completeStep(db, executionId, step.id, run, {});
    else await failStep(db, executionId, step.id, run, { result: "FAILED" });
    return;
  }

  const status = patch.status;
  if (!status || status === step.status) return;

  switch (status) {
    case "VERIFIED": {
      requireActive(step, isActive, ["IN_PROGRESS"]);
      if (step.type === "APPROVAL") throw new SopEngineError(400, "Approval steps complete through the approvals endpoint");
      if (step.type === "CONDITION") throw new SopEngineError(400, "Condition steps are evaluated automatically");
      if (step.type === "TESTING" && config.requireResult !== false) {
        throw new SopEngineError(400, "Record a test result (PASSED or FAILED) to finish this step");
      }
      if (step.type === "CHECKLIST") {
        const state = asObject(asObject(fresh.data).checklist);
        const items = Array.isArray(config.items) ? (config.items as { key: string; label: string; required?: boolean }[]) : [];
        const missing = items.filter((i) => i.required !== false && !asObject(state[i.key]).done);
        if (missing.length) throw new SopEngineError(400, `Tick every required item first: ${missing.map((i) => i.label).join(", ")}`);
      }
      if (step.requiresSignoff && !fresh.notes.trim()) {
        throw new SopEngineError(400, "This step requires sign-off notes before it can be verified");
      }
      return completeStep(db, executionId, step.id, run, {});
    }
    case "FAILED":
      requireActive(step, isActive, ["IN_PROGRESS", "BLOCKED"]);
      return failStep(db, executionId, step.id, run, {});
    case "BLOCKED":
      requireActive(step, isActive, ["IN_PROGRESS"]);
      return blockStep(db, executionId, step.id, run, patch.notes);
    case "SKIPPED":
      requireActive(step, isActive, ["IN_PROGRESS", "BLOCKED", "FAILED"]);
      if (config.mandatory === true) throw new SopEngineError(400, "This step is mandatory and can't be skipped");
      return skipStep(db, executionId, step.id, run, "MANUAL");
    case "IN_PROGRESS":
    case "PENDING": {
      if (isActive && (step.status === "FAILED" || step.status === "BLOCKED")) return retryStep(db, executionId, step, run);
      // Re-opening a finished step rewinds the run to it (later steps reset).
      const current = execution.steps.find((s) => s.id === execution.currentStepId);
      const isEarlier = execution.status === "COMPLETED" || !current || step.position < current.position;
      if (step.status !== "PENDING" && isEarlier) return gotoStep(db, executionId, stepKeyOf(step), run, "MANUAL");
      throw new SopEngineError(409, "Steps run in order — this one starts automatically when the earlier steps finish");
    }
  }
}

function requireActive(step: RunbookStep, isActive: boolean, statuses: string[]) {
  if (!isActive || !statuses.includes(step.status)) {
    throw new SopEngineError(409, `${stepLabel(step)} isn't the active step`);
  }
}

/** Records an approval / rejection; completes the step once enough approvals are in. */
export async function submitApproval(
  db: Db,
  executionId: string,
  stepId: string,
  actorId: string,
  input: { decision: "APPROVED" | "REJECTED"; comment: string }
) {
  const execution = await lockedExecution(db, executionId);
  const step = execution.steps.find((s) => s.id === stepId);
  if (!step) throw new SopEngineError(404, "Step not found");
  if (step.type !== "APPROVAL") throw new SopEngineError(400, "This step does not require an approval");
  if (execution.currentStepId !== step.id || step.status !== "IN_PROGRESS") throw new SopEngineError(409, "Approval step is not active");

  const subject = subjectOf(execution);
  const adapter = SUBJECT_ADAPTERS[subject.type];
  const config = asObject(step.config);
  const approverIds = Array.isArray(config.approverIds) ? (config.approverIds as string[]) : [];
  const approverRoles = Array.isArray(config.approverRoles) ? (config.approverRoles as string[]) : [];
  if (approverIds.length > 0 && !approverIds.includes(actorId)) {
    throw new SopEngineError(403, "You're not one of this step's approvers");
  }
  if (approverRoles.length > 0) {
    const role = await adapter.approverRole(db, subject.id, actorId);
    if (!role || !approverRoles.includes(role)) {
      throw new SopEngineError(403, `Only ${approverRoles.join(" / ").toLowerCase()}s can approve this step`);
    }
  }
  if (config.preventSelfApproval === true) {
    const workers = new Set(await adapter.workerIds(db, subject.id));
    execution.steps
      .filter((s) => s.position < step.position && s.type !== "APPROVAL" && s.completedById)
      .forEach((s) => workers.add(s.completedById!));
    if (workers.has(actorId)) throw new SopEngineError(403, "You worked on this task, so someone else has to approve it");
  }
  if (step.approvals.some((a) => a.userId === actorId)) {
    throw new SopEngineError(409, "You have already submitted a decision for this step");
  }

  await db.runbookApproval.create({ data: { stepId, userId: actorId, ...input } });
  await recordEvent(db, executionId, actorId, "APPROVAL_RECEIVED", { stepId, decision: input.decision, comment: input.comment });
  const run = newRun(actorId);
  if (input.decision === "REJECTED") return failStep(db, executionId, stepId, run, { notes: input.comment });

  const required = typeof config.requiredApprovals === "number" ? Math.max(1, Math.floor(config.requiredApprovals)) : 1;
  const approvals = step.approvals.filter((a) => a.decision === "APPROVED").length + 1;
  if (approvals >= required) {
    await completeStep(db, executionId, stepId, run, { executor: `${approvals} approval${approvals === 1 ? "" : "s"}` });
  } else {
    await recordEvent(db, executionId, actorId, "APPROVAL_PENDING", { stepId, approvals, required });
  }
}

/** Execution-level PATCH: switch mode, cancel, or restart from the first step. */
export async function updateExecution(db: Db, executionId: string, actorId: string, input: { mode?: RunbookMode; action?: "CANCEL" | "RESTART" }) {
  await lockExecution(db, executionId);
  const execution = await loadExecution(db, executionId);
  if (input.mode) await db.issueRunbook.update({ where: { id: executionId }, data: { mode: input.mode } });
  if (input.action === "CANCEL") {
    if (execution.status === "SKIPPED" || execution.status === "COMPLETED") throw new SopEngineError(409, "This execution has already finished");
    await cancelExecution(db, executionId, actorId, "MANUAL");
  }
  if (input.action === "RESTART") {
    const first = execution.steps[0];
    if (first) await gotoStep(db, executionId, stepKeyOf(first), newRun(actorId), "RESTART");
  }
}

/** External automation (CI, scripts) finishing a waiting step via its callback token. */
export async function completeStepFromCallback(
  db: Db,
  token: string,
  input: { status: "SUCCESS" | "FAILURE"; output?: string; executor?: string }
) {
  const step = await db.runbookStep.findUnique({ where: { callbackToken: token } });
  if (!step) throw new SopEngineError(404, "Unknown or expired callback");
  const execution = await lockedExecution(db, step.runbookId);
  const current = execution.steps.find((s) => s.id === step.id);
  if (!current || current.callbackToken !== token || execution.currentStepId !== step.id || current.status !== "IN_PROGRESS") {
    throw new SopEngineError(409, "This step is no longer waiting for a callback");
  }
  const run = newRun(null);
  const executor = input.executor ?? "external callback";
  if (input.status === "SUCCESS") await completeStep(db, execution.id, step.id, run, { executor, output: input.output });
  else {
    await db.runbookStep.update({ where: { id: step.id }, data: { executor } });
    await failStep(db, execution.id, step.id, run, { output: input.output });
  }
  return execution.id;
}

/**
 * Finishes (or fails) waiting GITHUB_ACTION steps whose config matches `event`.
 * Called by the GitHub webhook for the issues a PR / workflow / push refers to.
 */
export async function handleGithubEvent(
  db: Db,
  issueId: string,
  event: { name: string; failed?: boolean; repository: string; branch: string | null; workflow: string | null; summary: string; url: string | null }
) {
  const executions = await db.issueRunbook.findMany({
    where: { issueId, status: { in: ["IN_PROGRESS", "FAILED"] }, currentStepId: { not: null } },
    select: { id: true },
  });
  let matched = 0;
  for (const { id } of executions) {
    await lockExecution(db, id);
    const execution = await loadExecution(db, id);
    const step = execution.steps.find((s) => s.id === execution.currentStepId);
    if (!step || step.type !== "GITHUB_ACTION" || step.status !== "IN_PROGRESS") continue;
    const config = asObject(step.config);
    if (config.event !== event.name) continue;
    if (typeof config.repository === "string" && config.repository.toLowerCase() !== event.repository.toLowerCase()) continue;
    if (typeof config.branch === "string" && config.branch !== event.branch) continue;
    if (typeof config.workflow === "string" && config.workflow !== event.workflow) continue;
    matched++;
    const run = newRun(null);
    const output = event.url ? `${event.summary}\n${event.url}` : event.summary;
    if (event.failed) {
      await db.runbookStep.update({ where: { id: step.id }, data: { executor: `github:${event.name}` } });
      await failStep(db, id, step.id, run, { output });
    } else {
      await completeStep(db, id, step.id, run, { executor: `github:${event.name}`, output });
    }
  }
  return matched;
}

/** Maps engine errors onto the API error contract; anything else is rethrown. */
export function isEngineError(error: unknown): error is SopEngineError {
  return error instanceof SopEngineError;
}

/** Runs `fn` in an engine transaction. */
export function engineTransaction<T>(fn: (db: Db) => Promise<T>) {
  return prisma.$transaction(fn, ENGINE_TX);
}

export { SUBJECT_COLUMN };
