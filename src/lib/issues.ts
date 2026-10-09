import type { z } from "zod";
import { Prisma, type IssueActivityType, type IssueRelationType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { memberOf, userSelect } from "@/lib/workspaces";
import type { listIssuesQuerySchema } from "@/lib/validation";

type Db = Prisma.TransactionClient;

/**
 * Fetches an issue only if the user is a member of its workspace. Returns null both when
 * the issue doesn't exist and when it's outside the user's workspaces — callers should
 * treat both as a 404.
 */
export async function getAccessibleIssue(userId: string, id: string) {
  return prisma.issue.findFirst({ where: { id, workspace: memberOf(userId) } });
}

/** Compact issue shape used wherever one issue references another. */
export const issueRefSelect = {
  id: true,
  key: true,
  title: true,
  status: true,
  type: true,
  priority: true,
} as const;

/** Shape of every issue in list/board responses. */
export const issueListInclude = {
  assignee: { select: userSelect },
  component: { select: { id: true, name: true } },
  epic: { select: { id: true, name: true, color: true } },
  sprint: { select: { id: true, name: true, status: true } },
  release: { select: { id: true, name: true } },
  _count: { select: { subtasks: true, comments: true, attachments: true } },
} satisfies Prisma.IssueInclude;

export async function recordActivity(
  db: Db,
  issueId: string,
  actorId: string | null,
  type: IssueActivityType,
  data: Prisma.InputJsonObject = {}
) {
  await db.issueActivity.create({ data: { issueId, actorId, type, data } });
}

type IssueRefs = {
  assigneeId?: string | null;
  parentId?: string | null;
  componentId?: string | null;
  epicId?: string | null;
  sprintId?: string | null;
  releaseId?: string | null;
  sopOverrideId?: string | null;
};

/**
 * Checks that every id the caller set on an issue points at something in the same
 * workspace (or project, for components and parents). Returns an error message for a
 * 400, or null if everything is valid. `issueId` is the issue being updated, if any.
 */
export async function validateIssueRefs(
  workspaceId: string,
  projectId: string,
  refs: IssueRefs,
  issueId?: string
): Promise<string | null> {
  const { assigneeId, parentId, componentId, epicId, sprintId, releaseId, sopOverrideId } = refs;

  if (assigneeId) {
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: assigneeId } },
    });
    if (!member) return "Assignee is not a member of this workspace";
  }
  if (componentId) {
    const found = await prisma.component.findFirst({ where: { id: componentId, projectId } });
    if (!found) return "Component not found in this project";
  }
  if (epicId) {
    const found = await prisma.epic.findFirst({ where: { id: epicId, workspaceId } });
    if (!found) return "Epic not found in this workspace";
  }
  if (sprintId) {
    const found = await prisma.sprint.findFirst({ where: { id: sprintId, workspaceId } });
    if (!found) return "Sprint not found in this workspace";
  }
  if (releaseId) {
    const found = await prisma.release.findFirst({ where: { id: releaseId, workspaceId } });
    if (!found) return "Release not found in this workspace";
  }
  if (sopOverrideId) {
    const found = await prisma.sop.findFirst({ where: { id: sopOverrideId, workspaceId } });
    if (!found) return "SOP override must be shared with this workspace";
  }
  if (parentId) {
    if (parentId === issueId) return "An issue can't be its own parent";
    const parent = await prisma.issue.findFirst({ where: { id: parentId, projectId } });
    if (!parent) return "Parent issue not found in this project";
    // Sub-tasks are one level deep, which also makes parent cycles impossible.
    if (parent.parentId) return "A sub-task can't have sub-tasks of its own";
    if (issueId) {
      const childCount = await prisma.issue.count({ where: { parentId: issueId } });
      if (childCount > 0) return "An issue with sub-tasks can't become a sub-task";
    }
  }
  return null;
}

type ListIssuesQuery = z.infer<typeof listIssuesQuerySchema>;

/** Translates list query params into a Prisma filter. `"me"`/`"none"` are resolved here. */
export function buildIssueWhere(userId: string, query: ListIssuesQuery): Prisma.IssueWhereInput {
  const resolve = (value: string | undefined) =>
    value === "me" ? userId : value === "none" ? null : value;

  return {
    ...(query.projectId && { projectId: query.projectId }),
    ...(query.status && { status: query.status }),
    ...(query.type && { type: query.type }),
    ...(query.priority && { priority: query.priority }),
    ...(query.assigneeId && { assigneeId: resolve(query.assigneeId) }),
    ...(query.reporterId && { reporterId: resolve(query.reporterId) ?? undefined }),
    ...(query.parentId && { parentId: resolve(query.parentId) }),
    ...(query.componentId && { componentId: resolve(query.componentId) }),
    ...(query.epicId && { epicId: resolve(query.epicId) }),
    ...(query.sprintId && { sprintId: resolve(query.sprintId) }),
    ...(query.releaseId && { releaseId: resolve(query.releaseId) }),
    ...(query.label && { labels: { has: query.label } }),
    ...(query.updatedSince && { updatedAt: { gte: query.updatedSince } }),
    ...(query.q && {
      OR: [
        { key: { contains: query.q, mode: "insensitive" } },
        { title: { contains: query.q, mode: "insensitive" } },
      ],
    }),
  };
}

export function issueOrderBy(sort: ListIssuesQuery["sort"]): Prisma.IssueOrderByWithRelationInput[] {
  switch (sort) {
    case "created":
      return [{ createdAt: "desc" }];
    case "position":
      return [{ position: "asc" }, { createdAt: "asc" }];
    case "priority":
      // Enum sorts in declaration order: URGENT first.
      return [{ priority: "asc" }, { updatedAt: "desc" }];
    default:
      return [{ updatedAt: "desc" }];
  }
}

/** Parses URLSearchParams into a plain object for zod. */
export function queryToObject(searchParams: URLSearchParams) {
  return Object.fromEntries(searchParams.entries());
}

const RELATION_LABELS: Record<IssueRelationType, { outward: string; inward: string }> = {
  BLOCKS: { outward: "blocks", inward: "is blocked by" },
  RELATES_TO: { outward: "relates to", inward: "relates to" },
  DUPLICATES: { outward: "duplicates", inward: "is duplicated by" },
};

export function relationLabel(type: IssueRelationType, direction: "outward" | "inward") {
  return RELATION_LABELS[type][direction];
}

export const runbookInclude = {
  events: { orderBy: { createdAt: "asc" }, include: { actor: { select: userSelect } } },
  steps: {
    orderBy: { position: "asc" },
    include: {
      completedBy: { select: userSelect },
      approvals: { orderBy: { createdAt: "asc" }, include: { user: { select: userSelect } } },
    },
  },
} satisfies Prisma.IssueRunbookInclude;

type RunbookWithSteps = Prisma.IssueRunbookGetPayload<{ include: typeof runbookInclude }>;

export async function getRunbook(issueId: string, runbookId: string) {
  return prisma.issueRunbook.findFirst({
    where: { id: runbookId, issueId },
    include: runbookInclude,
  });
}

/** An execution by id with its steps, approvals and history — for task-owned executions. */
export async function getTaskRunbook(taskId: string, runbookId: string) {
  return prisma.issueRunbook.findFirst({
    where: { id: runbookId, taskId },
    include: runbookInclude,
  });
}

/** An execution by id — for note-owned executions. */
export async function getNoteRunbook(noteId: string, runbookId: string) {
  return prisma.issueRunbook.findFirst({
    where: { id: runbookId, noteId },
    include: runbookInclude,
  });
}

export async function listRunbooks(where: { issueId: string } | { taskId: string } | { noteId: string }) {
  const runbooks = await prisma.issueRunbook.findMany({
    where,
    orderBy: { createdAt: "asc" },
    include: runbookInclude,
  });
  return runbooks.map(withRunbookProgress);
}

/**
 * Adds `progress` so clients don't recompute it: counts, percent, the current step,
 * and step ids grouped by status (completed / pending / failed / skipped / ...).
 * Approvals are annotated with whether they count toward the step's current attempt.
 */
export function withRunbookProgress(runbook: RunbookWithSteps) {
  const total = runbook.steps.length;
  const ids = (...statuses: string[]) => runbook.steps.filter((s) => statuses.includes(s.status)).map((s) => s.id);
  const completedIds = ids("VERIFIED");
  const skippedIds = ids("SKIPPED");
  const current =
    runbook.steps.find((s) => s.id === runbook.currentStepId) ??
    runbook.steps.find((s) => s.status !== "VERIFIED" && s.status !== "SKIPPED");
  return {
    ...runbook,
    steps: runbook.steps.map((step) => ({
      ...step,
      approvals: step.approvals.map((a) => ({ ...a, current: a.attempt === step.attempt })),
    })),
    progress: {
      completed: completedIds.length + skippedIds.length,
      total,
      percent: total === 0 ? 100 : Math.round(((completedIds.length + skippedIds.length) / total) * 100),
      currentStepId: runbook.status === "COMPLETED" || runbook.status === "SKIPPED" ? null : current?.id ?? null,
      completedStepIds: completedIds,
      skippedStepIds: skippedIds,
      pendingStepIds: ids("PENDING"),
      inProgressStepIds: ids("IN_PROGRESS"),
      failedStepIds: ids("FAILED"),
      blockedStepIds: ids("BLOCKED"),
    },
  };
}

/** Relations in both directions, labelled from `issueId`'s point of view. */
export async function listRelations(issueId: string) {
  const [outgoing, incoming] = await Promise.all([
    prisma.issueRelation.findMany({
      where: { fromIssueId: issueId },
      orderBy: { createdAt: "asc" },
      include: { toIssue: { select: issueRefSelect } },
    }),
    prisma.issueRelation.findMany({
      where: { toIssueId: issueId },
      orderBy: { createdAt: "asc" },
      include: { fromIssue: { select: issueRefSelect } },
    }),
  ]);
  return [
    ...outgoing.map((r) => ({
      id: r.id,
      type: r.type,
      direction: "outward" as const,
      label: relationLabel(r.type, "outward"),
      issue: r.toIssue,
    })),
    ...incoming.map((r) => ({
      id: r.id,
      type: r.type,
      direction: "inward" as const,
      label: relationLabel(r.type, "inward"),
      issue: r.fromIssue,
    })),
  ];
}

/**
 * Full issue payload for the detail view: all relations the issue page renders, plus
 * derived time tracking, sub-task progress and whether the caller is watching.
 */
export async function getIssueDetail(userId: string, id: string) {
  const issue = await prisma.issue.findUnique({
    where: { id },
    include: {
      project: { select: { id: true, key: true, name: true } },
      assignee: { select: userSelect },
      reporter: { select: userSelect },
      component: { select: { id: true, name: true } },
      epic: { select: { id: true, name: true, color: true, status: true } },
      sprint: { select: { id: true, name: true, status: true, startDate: true, endDate: true } },
      release: { select: { id: true, name: true, status: true } },
      parent: { select: issueRefSelect },
      subtasks: {
        orderBy: { number: "asc" },
        select: { ...issueRefSelect, assignee: { select: userSelect } },
      },
      acceptanceCriteria: { orderBy: { position: "asc" } },
      watchers: { include: { user: { select: userSelect } } },
      devLinks: { orderBy: { createdAt: "desc" } },
      _count: { select: { comments: true, attachments: true, workLogs: true } },
    },
  });
  if (!issue) return null;

  const [logged, runbooks, relations] = await Promise.all([
    prisma.workLog.aggregate({ where: { issueId: id }, _sum: { minutes: true } }),
    listRunbooks({ issueId: id }),
    listRelations(id),
  ]);
  const loggedMinutes = logged._sum.minutes ?? 0;

  const { watchers, ...rest } = issue;

  return {
    ...rest,
    relations,
    watchers: watchers.map((w) => w.user),
    isWatching: watchers.some((w) => w.userId === userId),
    runbooks,
    subtaskProgress: {
      done: issue.subtasks.filter((s) => s.status === "DONE").length,
      total: issue.subtasks.length,
    },
    acceptanceProgress: {
      done: issue.acceptanceCriteria.filter((c) => c.done).length,
      total: issue.acceptanceCriteria.length,
    },
    timeTracking: {
      estimateMinutes: issue.estimateMinutes,
      loggedMinutes,
      remainingMinutes:
        issue.estimateMinutes === null ? null : Math.max(issue.estimateMinutes - loggedMinutes, 0),
    },
  };
}

/**
 * Returns `ids` with `movingId` moved to `index` (clamped). Used to rewrite integer
 * `position`s for small ordered lists (SOP steps, acceptance criteria).
 */
export function reorder(ids: string[], movingId: string, index: number): string[] {
  const rest = ids.filter((id) => id !== movingId);
  const at = Math.max(0, Math.min(index, rest.length));
  return [...rest.slice(0, at), movingId, ...rest.slice(at)];
}

/** Serializes a field value for FIELD_CHANGED activity entries. */
export function activityValue(value: unknown): Prisma.InputJsonValue | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return value as Prisma.InputJsonValue;
}
