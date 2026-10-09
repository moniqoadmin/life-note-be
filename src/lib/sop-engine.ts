import {
  Prisma,
  type ApprovalDecision,
  type RunbookMode,
  type RunbookStatus,
  type RunbookStepStatus,
  type SopAssignmentType,
  type WorkspaceRole,
} from "@prisma/client";
import { evaluateCondition } from "@/lib/sop-conditions";
import { recordActivity } from "@/lib/issues";
import { sopActionSchema, stepConfigSchemas, type SopAction } from "@/lib/validation";

/**
 * SOP execution engine.
 *
 * An SOP (Sop + SopStep + SopRule) is a reusable *definition*. Starting it against an
 * issue or personal task creates an *execution* (IssueRunbook + RunbookStep rows,
 * with the definition snapshotted) that this module drives:
 *
 *   start → fire EXECUTION_STARTED rules → settle()
 *   settle(): find the next PENDING step → evaluate its condition → skip it or start
 *             it → automatic steps (CONDITION, AUTOMATED_ACTION) run immediately →
 *             stop at the first step waiting on a person or an external event →
 *             when nothing is left, COMPLETED.
 *
 * Every mutation (completing a step, an approval, a GitHub webhook, a rule action,
 * an issue edit) locks the execution row, changes state, fires matching rules and
 * calls settle() — so "what happens next" lives in one place. Rule actions and
 * automatic steps share one action registry (executeAction), and a per-call budget
 * stops GO_TO_STEP / rule loops from running forever (the execution is BLOCKED).
 *
 * All functions take a transaction client; callers own the transaction (use
 * ENGINE_TX_OPTIONS) and translate SopEngineError into an HTTP error.
 */

type Tx = Prisma.TransactionClient;

export class SopEngineError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409,
    message: string
  ) {
    super(message);
  }
}

/** Engine calls run many small queries; give them more room than Prisma's 5s default. */
export const ENGINE_TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 };

/** Executions that can still move (FAILED/BLOCKED can be retried or rewound). */
export const OPEN_EXECUTION_STATUSES: RunbookStatus[] = ["PENDING", "IN_PROGRESS", "BLOCKED", "FAILED"];
const HALTED_EXECUTION_STATUSES: RunbookStatus[] = ["COMPLETED", "FAILED", "SKIPPED", "BLOCKED"];
const FINISHED_STEP_STATUSES: RunbookStepStatus[] = ["VERIFIED", "SKIPPED"];

const STEP_BUDGET = 200;

type Run = { tx: Tx; actorId: string | null; budget: { left: number } };

function newRun(tx: Tx, actorId: string | null): Run {
  return { tx, actorId, budget: { left: STEP_BUDGET } };
}

async function lockExecution(tx: Tx, runbookId: string) {
  await tx.$queryRaw`SELECT "id" FROM "issue_runbooks" WHERE "id" = ${runbookId} FOR UPDATE`;
}

async function loadExecution(tx: Tx, runbookId: string) {
  return tx.issueRunbook.findUniqueOrThrow({
    where: { id: runbookId },
    include: { steps: { orderBy: { position: "asc" } } },
  });
}

type Execution = Awaited<ReturnType<typeof loadExecution>>;
type ExecutionStep = Execution["steps"][number];

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function recordRunbookEvent(
  tx: Tx,
  runbookId: string,
  actorId: string | null,
  type: string,
  data: Prisma.InputJsonObject = {}
) {
  return tx.runbookEvent.create({ data: { runbookId, actorId, type, data } });
}

// ---------------------------------------------------------------------------
// Evaluation context — what conditions can see (`issue.*`, `steps.<key>.*`, ...)
// ---------------------------------------------------------------------------

const issueContextInclude = {
  component: { select: { id: true, name: true } },
  project: { select: { id: true, key: true, name: true, leadId: true } },
} satisfies Prisma.IssueInclude;

type IssueForContext = Prisma.IssueGetPayload<{ include: typeof issueContextInclude }>;

function issueContext(issue: IssueForContext) {
  return {
    id: issue.id,
    key: issue.key,
    type: issue.type,
    status: issue.status,
    priority: issue.priority,
    labels: issue.labels,
    storyPoints: issue.storyPoints,
    estimateMinutes: issue.estimateMinutes,
    dueDate: issue.dueDate,
    slaDueAt: issue.slaDueAt,
    assigneeId: issue.assigneeId,
    reporterId: issue.reporterId,
    parentId: issue.parentId,
    projectId: issue.projectId,
    componentId: issue.componentId,
    epicId: issue.epicId,
    sprintId: issue.sprintId,
    releaseId: issue.releaseId,
    component: issue.component,
    project: { id: issue.project.id, key: issue.project.key, name: issue.project.name },
    fields: asObject(issue.customFields),
  };
}

/** A note's ancestors, root first (bounded so a corrupt cycle can't loop forever). */
export async function noteAncestors(tx: Tx, parentId: string | null) {
  const chain: { id: string; title: string; defaultSopId: string | null }[] = [];
  for (let id = parentId; id && chain.length < 50; ) {
    const parent = await tx.note.findUnique({
      where: { id },
      select: { id: true, title: true, parentId: true, defaultSopId: true },
    });
    if (!parent) break;
    chain.unshift({ id: parent.id, title: parent.title, defaultSopId: parent.defaultSopId });
    id = parent.parentId;
  }
  return chain;
}

/** Context for an issue, task or note alone (no execution) — also used by the condition tester. */
export async function buildTargetContext(
  tx: Tx,
  target: { issueId?: string | null; taskId?: string | null; noteId?: string | null }
): Promise<Record<string, unknown>> {
  if (target.issueId) {
    const issue = await tx.issue.findUniqueOrThrow({ where: { id: target.issueId }, include: issueContextInclude });
    return { issue: issueContext(issue) };
  }
  if (target.taskId) {
    const task = await tx.task.findUniqueOrThrow({ where: { id: target.taskId } });
    return { task: { id: task.id, title: task.title, status: task.status, dueDate: task.dueDate } };
  }
  if (target.noteId) {
    const note = await tx.note.findUniqueOrThrow({ where: { id: target.noteId } });
    const ancestors = await noteAncestors(tx, note.parentId);
    return {
      note: {
        id: note.id,
        title: note.title,
        parentId: note.parentId,
        depth: ancestors.length,
        // Titles from the root module down to the parent, e.g. ["payment-service", "Refunds"].
        path: ancestors.map((a) => a.title),
        module: ancestors[0] ? { id: ancestors[0].id, title: ancestors[0].title } : null,
      },
    };
  }
  return {};
}

async function buildContext(run: Run, ex: Execution, event?: Record<string, unknown>) {
  const approvals = await run.tx.runbookApproval.findMany({
    where: { step: { runbookId: ex.id } },
    select: { stepId: true, attempt: true, decision: true },
  });
  const count = (step: ExecutionStep, decision: ApprovalDecision) =>
    approvals.filter((a) => a.stepId === step.id && a.attempt === step.attempt && a.decision === decision).length;

  return {
    ...(await buildTargetContext(run.tx, ex)),
    execution: {
      id: ex.id,
      status: ex.status,
      mode: ex.mode,
      sopId: ex.sopId,
      sopVersion: ex.sopVersion,
      assignmentType: ex.assignmentType,
    },
    steps: Object.fromEntries(
      ex.steps.map((s) => [
        s.key,
        {
          type: s.type,
          status: s.status,
          result: s.result,
          attempt: s.attempt,
          approvals: count(s, "APPROVED"),
          rejections: count(s, "REJECTED"),
          startedAt: s.startedAt,
          completedAt: s.completedAt,
          completedById: s.completedById,
        },
      ])
    ),
    ...(event && { event }),
  };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

type SnapshotRule = { id: string; name: string; trigger: string; condition: unknown; actions: unknown[]; enabled: boolean };

function snapshotRules(ex: Execution): SnapshotRule[] {
  const rules = asObject(ex.definitionSnapshot).rules;
  if (!Array.isArray(rules)) return [];
  return rules.map((raw) => {
    const rule = asObject(raw);
    // Executions started before rules had `actions` stored a single `action`.
    const actions = Array.isArray(rule.actions) ? rule.actions : rule.action ? [rule.action] : [];
    return {
      id: String(rule.id ?? ""),
      name: String(rule.name ?? ""),
      trigger: String(rule.trigger ?? ""),
      condition: rule.condition,
      actions,
      enabled: rule.enabled !== false,
    };
  });
}

async function fireRules(run: Run, runbookId: string, trigger: string, event: Record<string, unknown> = {}) {
  const initial = await loadExecution(run.tx, runbookId);
  const rules = snapshotRules(initial).filter((r) => r.enabled && r.trigger === trigger);
  for (const rule of rules) {
    if (run.budget.left-- <= 0) {
      await haltForLoop(run, runbookId);
      return;
    }
    // Reload per rule: an earlier rule's actions may have changed the state.
    const ex = await loadExecution(run.tx, runbookId);
    const context = await buildContext(run, ex, { type: trigger, ...event });
    if (!evaluateCondition(rule.condition, context)) continue;
    await recordRunbookEvent(run.tx, runbookId, run.actorId, "RULE_EXECUTED", {
      ruleId: rule.id,
      name: rule.name,
      trigger,
      actions: rule.actions as Prisma.InputJsonArray,
    });
    for (const action of rule.actions) {
      await executeAction(run, runbookId, action, { ruleId: rule.id });
    }
  }
}

async function haltForLoop(run: Run, runbookId: string) {
  await run.tx.issueRunbook.update({ where: { id: runbookId }, data: { status: "BLOCKED" } });
  await recordRunbookEvent(run.tx, runbookId, run.actorId, "LOOP_LIMIT", {
    message: "Too many automatic transitions in one operation; check rules and GO_TO_STEP targets for cycles.",
  });
}

// ---------------------------------------------------------------------------
// Action registry (rules + AUTOMATED_ACTION steps)
// ---------------------------------------------------------------------------

type ActionResult = { ok: true } | { ok: false; error: string };

async function executeAction(
  run: Run,
  runbookId: string,
  raw: unknown,
  source: Record<string, string>
): Promise<ActionResult> {
  const result = await applyAction(run, runbookId, raw);
  if (!result.ok) {
    await recordRunbookEvent(run.tx, runbookId, run.actorId, "ACTION_FAILED", {
      ...source,
      action: (raw ?? null) as Prisma.InputJsonValue,
      error: result.error,
    });
  }
  return result;
}

async function applyAction(run: Run, runbookId: string, raw: unknown): Promise<ActionResult> {
  const parsed = sopActionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Invalid action" };
  const action: SopAction = parsed.data;
  const { tx } = run;
  const ex = await loadExecution(tx, runbookId);
  const findStep = (key: string) => ex.steps.find((s) => s.key === key);

  const issue = ex.issueId ? await tx.issue.findUniqueOrThrow({ where: { id: ex.issueId } }) : null;
  const needIssue = (): ActionResult | null => (issue ? null : { ok: false, error: `${action.type} needs an issue` });
  const changeIssue = async (field: string, data: Prisma.IssueUncheckedUpdateInput, from: unknown, to: unknown) => {
    await tx.issue.update({ where: { id: issue!.id }, data });
    await recordActivity(tx, issue!.id, run.actorId, "FIELD_CHANGED", {
      field,
      from: (from ?? null) as Prisma.InputJsonValue,
      to: (to ?? null) as Prisma.InputJsonValue,
      via: "SOP",
      runbookId,
    });
  };

  switch (action.type) {
    case "SET_ISSUE_STATUS": {
      const missing = needIssue();
      if (missing) return missing;
      if (issue!.status === action.status) return { ok: true };
      await changeIssue(
        "status",
        { status: action.status, resolvedAt: action.status === "DONE" ? new Date() : null },
        issue!.status,
        action.status
      );
      return { ok: true };
    }
    case "SET_TASK_STATUS": {
      if (!ex.taskId) return { ok: false, error: "SET_TASK_STATUS needs a task" };
      await tx.task.update({ where: { id: ex.taskId }, data: { status: action.status } });
      return { ok: true };
    }
    case "ADD_LABEL":
    case "REMOVE_LABEL": {
      const missing = needIssue();
      if (missing) return missing;
      const labels =
        action.type === "ADD_LABEL"
          ? [...new Set([...issue!.labels, action.label])]
          : issue!.labels.filter((l) => l !== action.label);
      if (labels.length !== issue!.labels.length) await changeIssue("labels", { labels }, issue!.labels, labels);
      return { ok: true };
    }
    case "ASSIGN_ISSUE": {
      const missing = needIssue();
      if (missing) return missing;
      if (action.userId) {
        const member = await tx.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId: issue!.workspaceId, userId: action.userId } },
        });
        if (!member) return { ok: false, error: "Assignee is not a member of this workspace" };
      }
      if (issue!.assigneeId !== action.userId) {
        await changeIssue("assigneeId", { assigneeId: action.userId }, issue!.assigneeId, action.userId);
      }
      return { ok: true };
    }
    case "SET_ISSUE_FIELD": {
      const missing = needIssue();
      if (missing) return missing;
      const fields = asObject(issue!.customFields);
      const next = { ...fields, [action.field]: action.value };
      await changeIssue(
        `fields.${action.field}`,
        { customFields: next as Prisma.InputJsonObject },
        fields[action.field],
        action.value
      );
      return { ok: true };
    }
    case "SET_RUNBOOK_STATUS": {
      if (action.status === "SKIPPED") {
        await cancelExecution(run, runbookId, "RULE");
        return { ok: true };
      }
      // FAILED/BLOCKED halt the execution at the current step, so it can be retried.
      const current = ex.steps.find((s) => s.status === "IN_PROGRESS");
      if (current) {
        await tx.runbookStep.update({
          where: { id: current.id },
          data: { status: action.status, completedAt: new Date(), completedById: run.actorId },
        });
      }
      await tx.issueRunbook.update({
        where: { id: runbookId },
        data: { status: action.status, ...(current && { currentStepId: current.id }) },
      });
      return { ok: true };
    }
    case "GO_TO_STEP":
      return jumpToStep(run, runbookId, action.stepKey);
    case "SKIP_STEP": {
      const step = findStep(action.stepKey);
      if (!step) return { ok: false, error: `No step "${action.stepKey}"` };
      if (FINISHED_STEP_STATUSES.includes(step.status)) return { ok: true };
      await transitionStep(run, ex, step, "SKIPPED", { reason: "RULE", system: true });
      return { ok: true };
    }
    case "REQUIRE_APPROVALS":
    case "SET_STEP_CONFIG": {
      const step = findStep(action.stepKey);
      if (!step) return { ok: false, error: `No step "${action.stepKey}"` };
      if (FINISHED_STEP_STATUSES.includes(step.status)) return { ok: false, error: `Step "${step.key}" already finished` };
      const patch = action.type === "REQUIRE_APPROVALS" ? { requiredApprovals: action.count } : action.config;
      const merged = { ...asObject(step.config), ...patch };
      const valid = stepConfigSchemas[step.type].safeParse(merged);
      if (!valid.success) return { ok: false, error: `Resulting config is invalid for a ${step.type} step` };
      await tx.runbookStep.update({ where: { id: step.id }, data: { config: valid.data as Prisma.InputJsonObject } });
      return { ok: true };
    }
  }
}

// ---------------------------------------------------------------------------
// Step transitions
// ---------------------------------------------------------------------------

const STEP_EVENT: Record<RunbookStepStatus, string> = {
  PENDING: "STEP_RESET",
  IN_PROGRESS: "STEP_STARTED",
  VERIFIED: "STEP_COMPLETED",
  FAILED: "STEP_FAILED",
  BLOCKED: "STEP_BLOCKED",
  SKIPPED: "STEP_SKIPPED",
};

type TransitionOptions = {
  result?: string | null;
  notes?: string;
  output?: string;
  executor?: string | null;
  reason?: string;
  /** Completed by the engine itself (automatic step, rule) rather than the actor. */
  system?: boolean;
  /** Re-running a FAILED/BLOCKED step: starts a new attempt. */
  retry?: boolean;
};

/** Moves one step to `to`, keeps the execution's status/currentStepId in step, logs it, and fires rules. */
async function transitionStep(
  run: Run,
  ex: Execution,
  step: ExecutionStep,
  to: RunbookStepStatus,
  options: TransitionOptions = {}
) {
  const { tx } = run;
  const now = new Date();
  const ended = to !== "PENDING" && to !== "IN_PROGRESS";
  const attempt = options.retry ? step.attempt + 1 : step.attempt;
  const executor = options.executor ?? (options.system ? "system" : undefined);

  await tx.runbookStep.update({
    where: { id: step.id },
    data: {
      status: to,
      attempt,
      ...(options.result !== undefined && { result: options.result }),
      ...(options.retry && { result: null }),
      ...(options.notes !== undefined && { notes: options.notes }),
      ...(options.output !== undefined && { output: options.output }),
      ...(executor !== undefined && { executor }),
      ...(to === "IN_PROGRESS" && { startedAt: now }),
      completedAt: ended ? now : null,
      completedById: ended && !options.system ? run.actorId : null,
    },
  });

  if (to === "IN_PROGRESS" || to === "FAILED" || to === "BLOCKED") {
    await tx.issueRunbook.update({
      where: { id: ex.id },
      data: {
        status: to,
        currentStepId: step.id,
        ...(to === "IN_PROGRESS" && !ex.startedAt && { startedAt: now }),
      },
    });
  }

  const result = options.result !== undefined ? options.result : options.retry ? null : step.result;
  await recordRunbookEvent(tx, ex.id, options.system ? null : run.actorId, options.retry ? "STEP_RETRIED" : STEP_EVENT[to], {
    stepId: step.id,
    stepKey: step.key,
    title: step.title,
    attempt,
    result,
    ...(options.reason && { reason: options.reason }),
    ...(executor && { executor }),
    ...(options.notes && { notes: options.notes }),
    ...(options.output && { output: options.output }),
  });
  if (ex.issueId) {
    await recordActivity(tx, ex.issueId, options.system ? null : run.actorId, "RUNBOOK_STEP_UPDATED", {
      runbookId: ex.id,
      stepId: step.id,
      step: step.position + 1,
      title: step.title,
      from: step.status,
      to,
      ...(executor && { executor }),
    });
  }
  if (to !== "PENDING") {
    await fireRules(run, ex.id, STEP_EVENT[to], {
      step: { id: step.id, key: step.key, type: step.type, status: to, result, attempt },
    });
  }
}

/**
 * Moves execution to `key`. Backwards (or onto itself): that step and everything
 * after it become PENDING again on a new attempt. Forwards: unfinished steps in
 * between are SKIPPED. The next settle() starts the target.
 */
async function jumpToStep(run: Run, runbookId: string, key: string): Promise<ActionResult> {
  const { tx } = run;
  const ex = await loadExecution(tx, runbookId);
  const target = ex.steps.find((s) => s.key === key);
  if (!target) return { ok: false, error: `No step "${key}"` };
  const from = ex.steps.find((s) => s.id === ex.currentStepId) ?? ex.steps.find((s) => s.status === "IN_PROGRESS");
  const now = new Date();

  for (const step of ex.steps) {
    if (step.position >= target.position) {
      if (step.status === "PENDING") continue;
      await tx.runbookStep.update({
        where: { id: step.id },
        data: {
          status: "PENDING",
          attempt: step.attempt + 1,
          result: null,
          data: {},
          startedAt: null,
          completedAt: null,
          completedById: null,
          executor: null,
        },
      });
    } else if (!FINISHED_STEP_STATUSES.includes(step.status)) {
      await tx.runbookStep.update({
        where: { id: step.id },
        data: { status: "SKIPPED", completedAt: now, completedById: run.actorId },
      });
    }
  }
  await tx.issueRunbook.update({
    where: { id: runbookId },
    data: { status: "IN_PROGRESS", currentStepId: null, completedAt: null },
  });
  await recordRunbookEvent(tx, runbookId, run.actorId, "EXECUTION_JUMPED", {
    from: from?.key ?? null,
    to: key,
    direction: from && target.position > from.position ? "FORWARD" : "BACKWARD",
  });
  return { ok: true };
}

async function cancelExecution(run: Run, runbookId: string, reason: string) {
  const now = new Date();
  await run.tx.runbookStep.updateMany({
    where: { runbookId, status: { in: ["PENDING", "IN_PROGRESS", "BLOCKED", "FAILED"] } },
    data: { status: "SKIPPED", completedAt: now },
  });
  await run.tx.issueRunbook.update({
    where: { id: runbookId },
    data: { status: "SKIPPED", currentStepId: null, completedAt: now },
  });
  await recordRunbookEvent(run.tx, runbookId, run.actorId, "EXECUTION_CANCELLED", { reason });
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/** Advances the execution as far as it can go without a person or external event. */
async function settle(run: Run, runbookId: string) {
  const { tx } = run;
  for (;;) {
    if (run.budget.left-- <= 0) {
      await haltForLoop(run, runbookId);
      return;
    }
    const ex = await loadExecution(tx, runbookId);
    if (HALTED_EXECUTION_STATUSES.includes(ex.status)) return;

    const active = ex.steps.find((s) => s.status === "IN_PROGRESS");
    if (active) {
      if (active.type === "CONDITION") {
        await runConditionStep(run, ex, active);
        continue;
      }
      if (active.type === "AUTOMATED_ACTION") {
        await runAutomatedStep(run, ex, active);
        continue;
      }
      if (ex.status !== "IN_PROGRESS" || ex.currentStepId !== active.id) {
        await tx.issueRunbook.update({ where: { id: ex.id }, data: { status: "IN_PROGRESS", currentStepId: active.id } });
      }
      return; // Waiting on a person or an external event.
    }

    const stuck = ex.steps.find((s) => s.status === "FAILED" || s.status === "BLOCKED");
    if (stuck) {
      await tx.issueRunbook.update({
        where: { id: ex.id },
        data: { status: stuck.status === "FAILED" ? "FAILED" : "BLOCKED", currentStepId: stuck.id },
      });
      return;
    }

    const next = ex.steps.find((s) => s.status === "PENDING");
    if (!next) {
      await tx.issueRunbook.update({
        where: { id: ex.id },
        data: { status: "COMPLETED", currentStepId: null, completedAt: new Date() },
      });
      await recordRunbookEvent(tx, ex.id, run.actorId, "EXECUTION_COMPLETED", {});
      // A rule may reopen the execution (e.g. GO_TO_STEP); the loop picks that up.
      await fireRules(run, ex.id, "EXECUTION_COMPLETED");
      continue;
    }

    const context = await buildContext(run, ex);
    if (!evaluateCondition(next.condition, context)) {
      await transitionStep(run, ex, next, "SKIPPED", { reason: "CONDITION_FALSE", system: true });
      continue;
    }
    await transitionStep(run, ex, next, "IN_PROGRESS", { system: true });
  }
}

async function stillActive(tx: Tx, step: ExecutionStep) {
  const fresh = await tx.runbookStep.findUniqueOrThrow({ where: { id: step.id } });
  return fresh.status === "IN_PROGRESS" && fresh.attempt === step.attempt;
}

async function runConditionStep(run: Run, ex: Execution, step: ExecutionStep) {
  const config = stepConfigSchemas.CONDITION.safeParse(step.config);
  if (!config.success) {
    await transitionStep(run, ex, step, "FAILED", { system: true, output: "Invalid CONDITION step config" });
    return;
  }
  const holds = evaluateCondition(config.data.condition, await buildContext(run, ex));
  const transition = holds ? config.data.onTrue : config.data.onFalse;
  const result = holds ? "TRUE" : "FALSE";
  switch (transition.then) {
    case "CONTINUE":
      await transitionStep(run, ex, step, "VERIFIED", { system: true, result });
      return;
    case "FAIL":
      await transitionStep(run, ex, step, "FAILED", { system: true, result });
      return;
    case "BLOCK":
      await transitionStep(run, ex, step, "BLOCKED", { system: true, result });
      return;
    case "GO_TO_STEP":
      await transitionStep(run, ex, step, "VERIFIED", { system: true, result });
      await executeAction(run, ex.id, { type: "GO_TO_STEP", stepKey: transition.stepKey }, { stepKey: step.key });
      return;
  }
}

async function runAutomatedStep(run: Run, ex: Execution, step: ExecutionStep) {
  const config = stepConfigSchemas.AUTOMATED_ACTION.safeParse(step.config);
  if (!config.success) {
    await transitionStep(run, ex, step, "FAILED", { system: true, output: "Invalid AUTOMATED_ACTION step config" });
    return;
  }
  const done: string[] = [];
  for (const action of config.data.actions) {
    const result = await executeAction(run, ex.id, action, { stepKey: step.key });
    // An action (e.g. GO_TO_STEP) may have moved execution away from this step.
    if (!(await stillActive(run.tx, step))) return;
    if (!result.ok) {
      await transitionStep(run, ex, step, "FAILED", {
        system: true,
        result: "FAILED",
        output: [...done, `${action.type}: ${result.error}`].join("\n"),
      });
      return;
    }
    done.push(`${action.type}: ok`);
  }
  await transitionStep(run, ex, step, "VERIFIED", { system: true, result: "SUCCEEDED", output: done.join("\n") });
}

// ---------------------------------------------------------------------------
// Starting executions & SOP assignment
// ---------------------------------------------------------------------------

export type ExecutionTarget =
  | { issueId: string; taskId?: never; noteId?: never }
  | { taskId: string; issueId?: never; noteId?: never }
  | { noteId: string; issueId?: never; taskId?: never };

/** Snapshots the SOP's current definition into a new execution and runs it to its first waiting step. */
export async function startExecution(
  tx: Tx,
  params: {
    target: ExecutionTarget;
    sopId: string;
    assignmentType: SopAssignmentType;
    actorId: string | null;
    mode?: RunbookMode;
  }
) {
  const sop = await tx.sop.findUniqueOrThrow({
    where: { id: params.sopId },
    include: { steps: { orderBy: { position: "asc" } }, rules: { orderBy: { createdAt: "asc" } } },
  });
  const snapshot = {
    id: sop.id,
    title: sop.title,
    version: sop.version,
    steps: sop.steps.map((s) => ({
      id: s.id,
      key: s.key,
      position: s.position,
      title: s.title,
      description: s.description,
      command: s.command,
      requiresSignoff: s.requiresSignoff,
      type: s.type,
      config: s.config,
      condition: s.condition,
    })),
    rules: sop.rules.map((r) => ({
      id: r.id,
      name: r.name,
      trigger: r.trigger,
      condition: r.condition,
      actions: r.actions,
      enabled: r.enabled,
    })),
  } as Prisma.InputJsonObject;

  const execution = await tx.issueRunbook.create({
    data: {
      issueId: params.target.issueId ?? null,
      taskId: params.target.taskId ?? null,
      noteId: params.target.noteId ?? null,
      sopId: sop.id,
      sopVersion: sop.version,
      title: sop.title,
      mode: params.mode ?? "MANUAL",
      assignmentType: params.assignmentType,
      definitionSnapshot: snapshot,
      steps: {
        create: sop.steps.map((s, index) => ({
          key: s.key,
          position: index,
          title: s.title,
          description: s.description,
          command: s.command,
          requiresSignoff: s.requiresSignoff,
          type: s.type,
          config: s.config as Prisma.InputJsonValue,
          ...(s.condition !== null && { condition: s.condition as Prisma.InputJsonValue }),
        })),
      },
    },
  });

  const run = newRun(tx, params.actorId);
  await recordRunbookEvent(tx, execution.id, params.actorId, "EXECUTION_CREATED", {
    sopId: sop.id,
    sopVersion: sop.version,
    assignmentType: params.assignmentType,
  });
  if (params.target.issueId) {
    await recordActivity(tx, params.target.issueId, params.actorId, "RUNBOOK_ATTACHED", {
      runbookId: execution.id,
      title: sop.title,
      sopVersion: sop.version,
      assignmentType: params.assignmentType,
    });
  }
  await fireRules(run, execution.id, "EXECUTION_STARTED");
  await settle(run, execution.id);
  return execution.id;
}

export type SopResolution = {
  sopId: string;
  assignmentType: Extract<SopAssignmentType, "TASK_OVERRIDE" | "ENTITY_INHERITED">;
  /** The entity the SOP was inherited from, for ENTITY_INHERITED. */
  source: { type: "COMPONENT" | "NOTE"; id: string } | null;
};

/** Issue-level override → component (entity) default → none. SOPs must be shared with the issue's workspace. */
export async function resolveIssueSop(
  tx: Tx,
  issue: { workspaceId: string; componentId: string | null; sopOverrideId: string | null }
): Promise<SopResolution | null> {
  const shared = (id: string) => tx.sop.findFirst({ where: { id, workspaceId: issue.workspaceId }, select: { id: true } });
  if (issue.sopOverrideId && (await shared(issue.sopOverrideId))) {
    return { sopId: issue.sopOverrideId, assignmentType: "TASK_OVERRIDE", source: null };
  }
  if (issue.componentId) {
    const component = await tx.component.findUnique({ where: { id: issue.componentId }, select: { defaultSopId: true } });
    if (component?.defaultSopId && (await shared(component.defaultSopId))) {
      return {
        sopId: component.defaultSopId,
        assignmentType: "ENTITY_INHERITED",
        source: { type: "COMPONENT", id: issue.componentId },
      };
    }
  }
  return null;
}

/**
 * Makes the issue's automatically assigned execution match its resolved SOP. No-op
 * when the most recent auto-assigned execution already runs that SOP (even if it
 * finished), so unrelated edits never restart a workflow. Otherwise the open one
 * is cancelled (its history is kept) and a new execution starts.
 */
export async function syncIssueAssignment(tx: Tx, issueId: string, actorId: string | null) {
  const issue = await tx.issue.findUniqueOrThrow({ where: { id: issueId } });
  const resolved = await resolveIssueSop(tx, issue);
  return syncAssignment(tx, { issueId }, resolved, actorId);
}

/** Personal tasks have no entity, so only the task's own override applies (a private SOP of the owner). */
export async function syncTaskAssignment(tx: Tx, taskId: string, actorId: string | null) {
  const task = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
  const sop = task.sopOverrideId
    ? await tx.sop.findFirst({ where: { id: task.sopOverrideId, userId: task.userId, workspaceId: null } })
    : null;
  const resolved: SopResolution | null = sop ? { sopId: sop.id, assignmentType: "TASK_OVERRIDE", source: null } : null;
  return syncAssignment(tx, { taskId }, resolved, actorId);
}

/**
 * Notes: the note's own SOP (TASK_OVERRIDE) → the nearest ancestor's default SOP
 * (ENTITY_INHERITED) → none. Only SOPs the note's owner can use count.
 */
export async function resolveNoteSop(
  tx: Tx,
  note: { userId: string; parentId: string | null; sopOverrideId: string | null }
): Promise<SopResolution | null> {
  const usable = (id: string) =>
    tx.sop.findFirst({
      where: { id, OR: [{ userId: note.userId }, { workspace: { members: { some: { userId: note.userId } } } }] },
      select: { id: true },
    });
  if (note.sopOverrideId && (await usable(note.sopOverrideId))) {
    return { sopId: note.sopOverrideId, assignmentType: "TASK_OVERRIDE", source: null };
  }
  const ancestors = await noteAncestors(tx, note.parentId);
  for (const ancestor of ancestors.reverse()) {
    if (ancestor.defaultSopId && (await usable(ancestor.defaultSopId))) {
      return { sopId: ancestor.defaultSopId, assignmentType: "ENTITY_INHERITED", source: { type: "NOTE", id: ancestor.id } };
    }
  }
  return null;
}

export async function syncNoteAssignment(tx: Tx, noteId: string, actorId: string | null) {
  const note = await tx.note.findUniqueOrThrow({ where: { id: noteId } });
  return syncAssignment(tx, { noteId }, await resolveNoteSop(tx, note), actorId);
}

async function syncAssignment(
  tx: Tx,
  target: ExecutionTarget,
  resolved: SopResolution | null,
  actorId: string | null
) {
  const latest = await tx.issueRunbook.findFirst({
    where: { ...target, assignmentType: { in: ["TASK_OVERRIDE", "ENTITY_INHERITED"] } },
    orderBy: { createdAt: "desc" },
  });
  if (latest && resolved && latest.sopId === resolved.sopId) {
    if (latest.assignmentType !== resolved.assignmentType) {
      await tx.issueRunbook.update({ where: { id: latest.id }, data: { assignmentType: resolved.assignmentType } });
      await recordRunbookEvent(tx, latest.id, actorId, "ASSIGNMENT_CHANGED", {
        from: latest.assignmentType,
        to: resolved.assignmentType,
      });
    }
    return { runbookId: latest.id, resolution: resolved, started: false };
  }
  if (latest && OPEN_EXECUTION_STATUSES.includes(latest.status)) {
    await lockExecution(tx, latest.id);
    await cancelExecution(newRun(tx, actorId), latest.id, "REASSIGNED");
  }
  if (!resolved) return { runbookId: null, resolution: null, started: false };
  const runbookId = await startExecution(tx, {
    target,
    sopId: resolved.sopId,
    assignmentType: resolved.assignmentType,
    actorId,
  });
  if (resolved.source) {
    await recordRunbookEvent(tx, runbookId, actorId, "ASSIGNMENT_RESOLVED", {
      assignmentType: resolved.assignmentType,
      source: resolved.source,
    });
  }
  return { runbookId, resolution: resolved, started: true };
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

type Actor = { userId: string; role: WorkspaceRole | null; isProjectLead: boolean };

/** Task and note owners act as OWNER of their own executions. */
async function loadActor(tx: Tx, ex: Execution, userId: string): Promise<Actor> {
  if (ex.issueId) {
    const issue = await tx.issue.findUniqueOrThrow({
      where: { id: ex.issueId },
      select: { workspaceId: true, project: { select: { leadId: true } } },
    });
    const membership = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: issue.workspaceId, userId } },
    });
    return { userId, role: membership?.role ?? null, isProjectLead: issue.project.leadId === userId };
  }
  return { userId, role: "OWNER", isProjectLead: false };
}

function canManage(actor: Actor) {
  return actor.role === "OWNER" || actor.role === "ADMIN";
}

function assertCanAct(actor: Actor, step: ExecutionStep) {
  const config = asObject(step.config);
  const userIds = Array.isArray(config.allowedUserIds) ? (config.allowedUserIds as string[]) : [];
  const roles = Array.isArray(config.allowedRoles) ? (config.allowedRoles as string[]) : [];
  if (!userIds.length && !roles.length) return;
  if (userIds.includes(actor.userId) || (actor.role && roles.includes(actor.role))) return;
  throw new SopEngineError(403, `You're not allowed to act on step "${step.title}"`);
}

function assertCanApprove(actor: Actor, step: ExecutionStep) {
  const approvers = asObject(asObject(step.config).approvers);
  const userIds = Array.isArray(approvers.userIds) ? (approvers.userIds as string[]) : [];
  const roles = Array.isArray(approvers.roles) ? (approvers.roles as string[]) : [];
  const projectLead = approvers.projectLead === true;
  if (!userIds.length && !roles.length && !projectLead) return;
  if (
    userIds.includes(actor.userId) ||
    (actor.role && roles.includes(actor.role)) ||
    (projectLead && actor.isProjectLead)
  ) {
    return;
  }
  throw new SopEngineError(403, `You're not an approver for step "${step.title}"`);
}

// ---------------------------------------------------------------------------
// Public operations (one per API action)
// ---------------------------------------------------------------------------

async function openExecution(tx: Tx, runbookId: string, stepId?: string) {
  await lockExecution(tx, runbookId);
  const ex = await loadExecution(tx, runbookId);
  const step = stepId ? ex.steps.find((s) => s.id === stepId) : undefined;
  if (stepId && !step) throw new SopEngineError(404, "Step not found");
  return { ex, step: step as ExecutionStep };
}

export type StepUpdateInput = {
  status?: RunbookStepStatus;
  notes?: string;
  output?: string;
  executor?: string | null;
  result?: string;
  checkedItems?: string[];
};

export async function updateStep(
  tx: Tx,
  params: { runbookId: string; stepId: string; userId: string; input: StepUpdateInput }
) {
  const { ex, step } = await openExecution(tx, params.runbookId, params.stepId);
  const run = newRun(tx, params.userId);
  const actor = await loadActor(tx, ex, params.userId);
  const { notes, output, executor, checkedItems } = params.input;
  let { status, result } = params.input;

  if (checkedItems !== undefined) {
    if (step.type !== "CHECKLIST") throw new SopEngineError(400, "checkedItems only applies to CHECKLIST steps");
    if (step.status !== "IN_PROGRESS") throw new SopEngineError(409, "This step is not active");
    const items = stepConfigSchemas.CHECKLIST.safeParse(step.config);
    const known = new Set(items.success ? items.data.items.map((i) => i.id) : []);
    const unknown = checkedItems.find((id) => !known.has(id));
    if (unknown) throw new SopEngineError(400, `Unknown checklist item "${unknown}"`);
    assertCanAct(actor, step);
  }

  if (step.type === "TESTING" && result !== undefined) {
    result = result.toUpperCase();
    if (result !== "PASSED" && result !== "FAILED") throw new SopEngineError(400, "TESTING result must be PASSED or FAILED");
    status ??= result === "PASSED" ? "VERIFIED" : "FAILED";
    if (status === "VERIFIED" && result === "FAILED") throw new SopEngineError(400, "A failed test can't complete the step");
  }

  // Plain field edits apply whether or not the status changes.
  await tx.runbookStep.update({
    where: { id: step.id },
    data: {
      ...(notes !== undefined && { notes }),
      ...(output !== undefined && { output }),
      ...(executor !== undefined && { executor }),
      ...(checkedItems !== undefined && { data: { ...asObject(step.data), checkedItems: [...new Set(checkedItems)] } }),
    },
  });

  if (status === undefined || status === step.status) return;
  const finalNotes = notes ?? step.notes;

  switch (status) {
    case "PENDING": {
      assertCanAct(actor, step);
      const jumped = await jumpToStep(run, ex.id, step.key);
      if (!jumped.ok) throw new SopEngineError(400, jumped.error);
      break;
    }
    case "IN_PROGRESS": {
      if (step.status !== "FAILED" && step.status !== "BLOCKED") {
        throw new SopEngineError(409, "Steps start automatically when reached; only FAILED or BLOCKED steps can be retried");
      }
      assertCanAct(actor, step);
      await transitionStep(run, ex, step, "IN_PROGRESS", { retry: true });
      break;
    }
    case "VERIFIED": {
      if (step.status !== "IN_PROGRESS") throw new SopEngineError(409, "Only the active step can be completed");
      if (step.type === "APPROVAL") throw new SopEngineError(400, "Approval steps are completed through the approvals endpoint");
      if (step.type === "CONDITION" || step.type === "AUTOMATED_ACTION") {
        throw new SopEngineError(400, `${step.type} steps run automatically`);
      }
      if (step.type === "GITHUB_ACTION" && asObject(step.config).allowManualCompletion === false) {
        throw new SopEngineError(400, "This step completes from a GitHub event");
      }
      if (step.type === "CHECKLIST") {
        const config = stepConfigSchemas.CHECKLIST.safeParse(step.config);
        const checked = new Set(checkedItems ?? (asObject(step.data).checkedItems as string[] | undefined) ?? []);
        const missing = config.success ? config.data.items.find((i) => i.required && !checked.has(i.id)) : undefined;
        if (missing) throw new SopEngineError(400, `Checklist item "${missing.label}" isn't checked`);
      }
      if (step.type === "TESTING" && (result ?? step.result) !== "PASSED") {
        throw new SopEngineError(400, "Record result PASSED to complete a testing step");
      }
      if (step.requiresSignoff && !finalNotes.trim()) {
        throw new SopEngineError(400, "This step requires sign-off notes before it can be completed");
      }
      assertCanAct(actor, step);
      await transitionStep(run, ex, step, "VERIFIED", { result: result ?? step.result, executor });
      break;
    }
    case "FAILED":
    case "BLOCKED": {
      if (step.status !== "IN_PROGRESS") throw new SopEngineError(409, "Only the active step can fail or be blocked");
      assertCanAct(actor, step);
      await transitionStep(run, ex, step, status, { result: result ?? (status === "FAILED" ? "FAILED" : step.result), executor });
      break;
    }
    case "SKIPPED": {
      if (step.status === "VERIFIED") throw new SopEngineError(409, "Completed steps can't be skipped");
      // Skipping an approval bypasses it, so only workspace owners/admins may.
      if (step.type === "APPROVAL" && !canManage(actor)) {
        throw new SopEngineError(403, "Only owners and admins can skip an approval step");
      }
      assertCanAct(actor, step);
      if (step.status === "FAILED" || step.status === "BLOCKED") {
        await tx.issueRunbook.update({ where: { id: ex.id }, data: { status: "IN_PROGRESS" } });
      }
      await transitionStep(run, ex, step, "SKIPPED", { reason: "MANUAL" });
      break;
    }
  }
  await settle(run, ex.id);
}

export async function submitApproval(
  tx: Tx,
  params: { runbookId: string; stepId: string; userId: string; decision: ApprovalDecision; comment: string }
) {
  const { ex, step } = await openExecution(tx, params.runbookId, params.stepId);
  if (step.type !== "APPROVAL") throw new SopEngineError(400, "This step does not take approvals");
  if (step.status !== "IN_PROGRESS") throw new SopEngineError(409, "Approval step is not active");
  const actor = await loadActor(tx, ex, params.userId);
  assertCanApprove(actor, step);

  const previous = await tx.runbookApproval.findUnique({
    where: { stepId_userId_attempt: { stepId: step.id, userId: params.userId, attempt: step.attempt } },
  });
  if (previous) throw new SopEngineError(409, "You have already submitted a decision for this step");

  const run = newRun(tx, params.userId);
  await tx.runbookApproval.create({
    data: { stepId: step.id, userId: params.userId, decision: params.decision, comment: params.comment, attempt: step.attempt },
  });
  const approvals = await tx.runbookApproval.count({
    where: { stepId: step.id, attempt: step.attempt, decision: "APPROVED" },
  });
  const config = stepConfigSchemas.APPROVAL.safeParse(step.config);
  const required = config.success ? config.data.requiredApprovals : 1;
  await recordRunbookEvent(tx, ex.id, params.userId, "APPROVAL_RECEIVED", {
    stepId: step.id,
    stepKey: step.key,
    attempt: step.attempt,
    decision: params.decision,
    comment: params.comment,
    approvals,
    required,
  });

  if (params.decision === "REJECTED") {
    await transitionStep(run, ex, step, "FAILED", { result: "REJECTED", notes: params.comment });
  } else if (approvals >= required) {
    await transitionStep(run, ex, step, "VERIFIED", { result: "APPROVED" });
  }
  await settle(run, ex.id);
}

/** Execution-level controls: change mode, cancel, or jump to a step. */
export async function updateExecution(
  tx: Tx,
  params: { runbookId: string; userId: string; mode?: RunbookMode; status?: "SKIPPED"; goToStep?: string }
) {
  const { ex } = await openExecution(tx, params.runbookId);
  const run = newRun(tx, params.userId);
  if (params.mode) await tx.issueRunbook.update({ where: { id: ex.id }, data: { mode: params.mode } });
  if (params.status === "SKIPPED") {
    if (!OPEN_EXECUTION_STATUSES.includes(ex.status)) throw new SopEngineError(409, "This execution has already ended");
    await cancelExecution(run, ex.id, "MANUAL");
    return;
  }
  if (params.goToStep) {
    if (ex.status === "SKIPPED") throw new SopEngineError(409, "A cancelled execution can't be resumed");
    const jumped = await jumpToStep(run, ex.id, params.goToStep);
    if (!jumped.ok) throw new SopEngineError(400, jumped.error);
    await settle(run, ex.id);
  }
}

/** Fires ISSUE_UPDATED / TASK_UPDATED / NOTE_UPDATED (and ISSUE_STATUS_CHANGED) rules on the target's open executions. */
export async function handleTargetUpdated(
  tx: Tx,
  target: ExecutionTarget,
  changes: { statusChanged: boolean; fields: string[] },
  actorId: string | null
) {
  const executions = await tx.issueRunbook.findMany({
    where: { ...target, status: { in: OPEN_EXECUTION_STATUSES } },
    select: { id: true },
  });
  for (const { id } of executions) {
    await lockExecution(tx, id);
    const run = newRun(tx, actorId);
    const event = { fields: changes.fields };
    await fireRules(run, id, target.issueId ? "ISSUE_UPDATED" : target.taskId ? "TASK_UPDATED" : "NOTE_UPDATED", event);
    if (target.issueId && changes.statusChanged) await fireRules(run, id, "ISSUE_STATUS_CHANGED", event);
    await settle(run, id);
  }
}

export type ExternalEvent = {
  source: "github";
  type: "PR_OPENED" | "PR_MERGED" | "CHECKS_PASSED";
  baseBranch?: string | null;
  url?: string | null;
  title?: string | null;
};

/** Completes the active GITHUB_ACTION step if `event` matches its config. Returns whether it did. */
export async function handleExternalEvent(tx: Tx, runbookId: string, event: ExternalEvent) {
  const { ex } = await openExecution(tx, runbookId);
  if (HALTED_EXECUTION_STATUSES.includes(ex.status)) return false;
  const step = ex.steps.find((s) => s.status === "IN_PROGRESS" && s.type === "GITHUB_ACTION");
  if (!step) return false;
  const config = stepConfigSchemas.GITHUB_ACTION.safeParse(step.config);
  if (!config.success || config.data.event !== event.type) return false;
  if (config.data.baseBranch && config.data.baseBranch !== event.baseBranch) return false;

  const run = newRun(tx, null);
  await recordRunbookEvent(tx, ex.id, null, "EXTERNAL_EVENT", { ...event, stepKey: step.key });
  await transitionStep(run, ex, step, "VERIFIED", {
    system: true,
    executor: event.source,
    result: event.type,
    ...(event.url && { output: event.url }),
  });
  await settle(run, ex.id);
  return true;
}
