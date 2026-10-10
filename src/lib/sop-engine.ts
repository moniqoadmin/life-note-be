import { Prisma, type SopAssignmentType } from "@prisma/client";

type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { field: string; operator: string; value?: unknown };

type IssueContext = {
  type: string;
  status: string;
  priority: string;
  labels: string[];
  componentId: string | null;
  storyPoints: number | null;
  task?: { title: string; status: string };
};

const fieldValues: Record<string, (issue: IssueContext) => unknown> = {
  "issue.type": (i) => i.type,
  "issue.status": (i) => i.status,
  "issue.priority": (i) => i.priority,
  "issue.labels": (i) => i.labels,
  "issue.componentId": (i) => i.componentId,
  "issue.storyPoints": (i) => i.storyPoints,
  "task.status": (i) => i.task?.status,
  "task.title": (i) => i.task?.title,
};

/** Evaluates a constrained JSON condition tree; no user-provided code is executed. */
export function evaluateCondition(raw: unknown, issue: IssueContext): boolean {
  if (raw == null) return true;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const rule = raw as Condition;
  if ("all" in rule) return Array.isArray(rule.all) && rule.all.every((child) => evaluateCondition(child, issue));
  if ("any" in rule) return Array.isArray(rule.any) && rule.any.some((child) => evaluateCondition(child, issue));
  if (!("field" in rule) || !(rule.field in fieldValues) || typeof rule.operator !== "string") return false;
  const actual = fieldValues[rule.field](issue);
  const expected = rule.value;
  switch (rule.operator) {
    case "EXISTS": return actual !== null && actual !== undefined;
    case "EQUALS": return actual === expected;
    case "NOT_EQUALS": return actual !== expected;
    case "CONTAINS": return Array.isArray(actual) ? actual.includes(expected) : typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
    case "IN": return Array.isArray(expected) && expected.includes(actual);
    case "NOT_IN": return Array.isArray(expected) && !expected.includes(actual);
    case "GREATER_THAN": return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "LESS_THAN": return typeof actual === "number" && typeof expected === "number" && actual < expected;
    default: return false;
  }
}

export type RunbookIssue = IssueContext & { id: string; workspaceId: string };

/** Resolves issue override before component default and snapshots the selected definition. */
export async function createAssignedRunbook(
  tx: Prisma.TransactionClient,
  issue: RunbookIssue,
  overrideSopId?: string | null,
) {
  const component = issue.componentId
    ? await tx.component.findUnique({ where: { id: issue.componentId }, select: { defaultSopId: true } })
    : null;
  const sopId = overrideSopId ?? component?.defaultSopId ?? null;
  if (!sopId) return null;
  const assignmentType: SopAssignmentType = overrideSopId ? "TASK_OVERRIDE" : "ENTITY_INHERITED";
  const sop = await tx.sop.findFirst({
    where: { id: sopId, workspaceId: issue.workspaceId },
    include: { steps: { orderBy: { position: "asc" } }, rules: true },
  });
  if (!sop) return null;

  const snapshot = {
    id: sop.id,
    title: sop.title,
    version: sop.version,
    steps: sop.steps.map((step) => ({
      id: step.id, position: step.position, title: step.title, description: step.description,
      command: step.command, requiresSignoff: step.requiresSignoff, type: step.type,
      config: step.config, condition: step.condition,
    })),
    rules: sop.rules,
  } as Prisma.InputJsonObject;
  const runbook = await tx.issueRunbook.create({
    data: {
      issueId: issue.id, sopId: sop.id, sopVersion: sop.version, title: sop.title,
      assignmentType, definitionSnapshot: snapshot,
      steps: { create: sop.steps.map((step) => ({
        position: step.position, title: step.title, description: step.description,
        command: step.command, requiresSignoff: step.requiresSignoff, type: step.type,
        config: step.config as Prisma.InputJsonValue,
        ...(step.condition !== null && { condition: step.condition as Prisma.InputJsonValue }),
        status: evaluateCondition(step.condition, issue) ? "PENDING" : "SKIPPED",
        ...(evaluateCondition(step.condition, issue) ? {} : { completedAt: new Date() }),
      })) },
    },
    include: { steps: { orderBy: { position: "asc" } } },
  });
  const first = runbook.steps.find((step) => step.status === "PENDING");
  if (first) {
    await tx.runbookStep.update({ where: { id: first.id }, data: { status: "IN_PROGRESS" } });
    await tx.issueRunbook.update({ where: { id: runbook.id }, data: { status: "IN_PROGRESS", currentStepId: first.id } });
  } else {
    await tx.issueRunbook.update({ where: { id: runbook.id }, data: { status: "COMPLETED" } });
  }
  await recordRunbookEvent(tx, runbook.id, null, "EXECUTION_CREATED", {
    sopId: sop.id, sopVersion: sop.version, assignmentType,
  });
  return runbook.id;
}

export async function createTaskRunbook(
  tx: Prisma.TransactionClient,
  task: { id: string; userId: string; title: string; status: string },
  sopId: string,
) {
  const sop = await tx.sop.findFirst({
    where: { id: sopId, userId: task.userId, workspaceId: null },
    include: { steps: { orderBy: { position: "asc" } }, rules: true },
  });
  if (!sop) return null;
  const context: IssueContext = { type: "", status: "", priority: "", labels: [], componentId: null, storyPoints: null, task: { title: task.title, status: task.status } };
  const snapshot = { id: sop.id, title: sop.title, version: sop.version, steps: sop.steps, rules: sop.rules } as unknown as Prisma.InputJsonObject;
  const execution = await tx.issueRunbook.create({
    data: {
      taskId: task.id, sopId: sop.id, sopVersion: sop.version, title: sop.title,
      assignmentType: "TASK_OVERRIDE", definitionSnapshot: snapshot,
      steps: { create: sop.steps.map((step) => {
        const applies = evaluateCondition(step.condition, context);
        return {
          position: step.position, title: step.title, description: step.description,
          command: step.command, requiresSignoff: step.requiresSignoff, type: step.type,
          config: step.config as Prisma.InputJsonValue,
          ...(step.condition !== null && { condition: step.condition as Prisma.InputJsonValue }),
          status: applies ? "PENDING" as const : "SKIPPED" as const,
          ...(!applies && { completedAt: new Date() }),
        };
      }) },
    }, include: { steps: { orderBy: { position: "asc" } } },
  });
  const first = execution.steps.find((step) => step.status === "PENDING");
  if (first) {
    await tx.runbookStep.update({ where: { id: first.id }, data: { status: "IN_PROGRESS" } });
    await tx.issueRunbook.update({ where: { id: execution.id }, data: { status: "IN_PROGRESS", currentStepId: first.id } });
  } else {
    await tx.issueRunbook.update({ where: { id: execution.id }, data: { status: "COMPLETED" } });
  }
  await recordRunbookEvent(tx, execution.id, null, "EXECUTION_CREATED", { sopId: sop.id, sopVersion: sop.version, assignmentType: "TASK_OVERRIDE" });
  return execution.id;
}

export async function recordRunbookEvent(
  tx: Prisma.TransactionClient,
  runbookId: string,
  actorId: string | null,
  type: string,
  data: Prisma.InputJsonObject = {},
) {
  return tx.runbookEvent.create({ data: { runbookId, actorId, type, data } });
}

export async function advanceRunbook(
  tx: Prisma.TransactionClient,
  runbookId: string,
  issueId: string,
  completedStepId: string,
  actorId: string,
) {
  const completed = await tx.runbookStep.findUniqueOrThrow({ where: { id: completedStepId } });
  const issue = await tx.issue.findUniqueOrThrow({ where: { id: issueId } });
  const pending = await tx.runbookStep.findMany({
    where: { runbookId, position: { gt: completed.position }, status: "PENDING" },
    orderBy: { position: "asc" },
  });
  let next = null;
  for (const candidate of pending) {
    if (evaluateCondition(candidate.condition, issue)) {
      next = candidate;
      break;
    }
    await tx.runbookStep.update({ where: { id: candidate.id }, data: { status: "SKIPPED", completedAt: new Date(), completedById: actorId } });
    await recordRunbookEvent(tx, runbookId, actorId, "STEP_SKIPPED", { stepId: candidate.id, reason: "CONDITION_FALSE" });
  }
  if (next) {
    await tx.runbookStep.update({ where: { id: next.id }, data: { status: "IN_PROGRESS" } });
    await tx.issueRunbook.update({ where: { id: runbookId }, data: { status: "IN_PROGRESS", currentStepId: next.id } });
    await recordRunbookEvent(tx, runbookId, actorId, "STEP_STARTED", { stepId: next.id });
  } else {
    await tx.issueRunbook.update({ where: { id: runbookId }, data: { status: "COMPLETED", currentStepId: null } });
    await recordRunbookEvent(tx, runbookId, actorId, "EXECUTION_COMPLETED", {});
  }
  return next;
}

export async function advanceTaskRunbook(
  tx: Prisma.TransactionClient,
  runbookId: string,
  taskId: string,
  completedStepId: string,
  actorId: string,
) {
  const completed = await tx.runbookStep.findUniqueOrThrow({ where: { id: completedStepId } });
  const task = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
  const context: IssueContext = { type: "", status: "", priority: "", labels: [], componentId: null, storyPoints: null, task: { title: task.title, status: task.status } };
  const pending = await tx.runbookStep.findMany({ where: { runbookId, position: { gt: completed.position }, status: "PENDING" }, orderBy: { position: "asc" } });
  let next = null;
  for (const candidate of pending) {
    if (evaluateCondition(candidate.condition, context)) { next = candidate; break; }
    await tx.runbookStep.update({ where: { id: candidate.id }, data: { status: "SKIPPED", completedAt: new Date(), completedById: actorId } });
    await recordRunbookEvent(tx, runbookId, actorId, "STEP_SKIPPED", { stepId: candidate.id, reason: "CONDITION_FALSE" });
  }
  if (next) {
    await tx.runbookStep.update({ where: { id: next.id }, data: { status: "IN_PROGRESS" } });
    await tx.issueRunbook.update({ where: { id: runbookId }, data: { status: "IN_PROGRESS", currentStepId: next.id } });
    await recordRunbookEvent(tx, runbookId, actorId, "STEP_STARTED", { stepId: next.id });
  } else {
    await tx.issueRunbook.update({ where: { id: runbookId }, data: { status: "COMPLETED", currentStepId: null } });
    await recordRunbookEvent(tx, runbookId, actorId, "EXECUTION_COMPLETED", {});
  }
}

/** Runs the small, validated SOP action registry against a snapshotted rule set. */
export async function applySopRules(
  tx: Prisma.TransactionClient,
  runbookId: string,
  issueId: string,
  trigger: string,
  actorId: string | null,
) {
  const [runbook, issue] = await Promise.all([
    tx.issueRunbook.findUniqueOrThrow({ where: { id: runbookId } }),
    tx.issue.findUniqueOrThrow({ where: { id: issueId } }),
  ]);
  const snapshot = runbook.definitionSnapshot as { rules?: Array<{ id: string; name: string; trigger: string; condition: unknown; action: unknown; enabled: boolean }> };
  const rules = (snapshot.rules ?? []).filter((rule) => rule.enabled && rule.trigger === trigger && evaluateCondition(rule.condition, issue));
  for (const rule of rules) {
    const action = rule.action as { type?: string; status?: string };
    if (action.type === "SET_ISSUE_STATUS" && ["BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "DONE", "CANCELLED"].includes(action.status ?? "")) {
      const status = action.status as "BACKLOG" | "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE" | "CANCELLED";
      await tx.issue.update({ where: { id: issueId }, data: { status, resolvedAt: status === "DONE" ? new Date() : null } });
    } else if (action.type === "SET_RUNBOOK_STATUS" && ["FAILED", "BLOCKED", "SKIPPED"].includes(action.status ?? "")) {
      await tx.issueRunbook.update({ where: { id: runbookId }, data: { status: action.status as "FAILED" | "BLOCKED" | "SKIPPED" } });
    }
    await recordRunbookEvent(tx, runbookId, actorId, "RULE_EXECUTED", { ruleId: rule.id, name: rule.name, trigger, action: rule.action as Prisma.InputJsonObject });
  }
  return rules.length;
}
