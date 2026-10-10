import { Prisma, type IssueStatus, type WorkspaceRole } from "@prisma/client";
import { evaluateCondition, type SopContext } from "@/lib/sop/conditions";

type Db = Prisma.TransactionClient;

// A "subject" is the work item an SOP execution runs against. The engine only ever
// talks to subjects through these adapters, so adding a new kind of work item means
// adding an adapter here — nothing in the engine changes.
export type SubjectType = "ISSUE" | "NOTE" | "TASK";
export type SubjectRef = { type: SubjectType; id: string };

export const SUBJECT_COLUMN = { ISSUE: "issueId", NOTE: "noteId", TASK: "taskId" } as const;

export function subjectOf(execution: { issueId: string | null; noteId: string | null; taskId: string | null }): SubjectRef {
  if (execution.issueId) return { type: "ISSUE", id: execution.issueId };
  if (execution.noteId) return { type: "NOTE", id: execution.noteId };
  return { type: "TASK", id: execution.taskId! };
}

export function subjectWhere(subject: SubjectRef) {
  return { [SUBJECT_COLUMN[subject.type]]: subject.id } as { issueId: string } | { noteId: string } | { taskId: string };
}

export type AssignmentScopeType = "NOTE" | "COMPONENT" | "PROJECT";

export type Resolution = {
  sopId: string;
  assignmentType: "ENTITY_INHERITED" | "TASK_OVERRIDE";
  source:
    | { kind: "OVERRIDE" }
    | { kind: "ASSIGNMENT"; assignmentId: string; scopeType: AssignmentScopeType; scopeId: string; scopeName: string };
};

export type NotifyRecipient = "ASSIGNEE" | "REPORTER" | "WATCHERS" | "OWNER";

export interface SubjectAdapter {
  /** Can `userId` see and work on this subject? */
  canAccess(db: Db, userId: string, id: string): Promise<boolean>;
  /** Subject-specific part of the condition context (issue/note/task/entity/fields/…). */
  loadContext(db: Db, id: string): Promise<SopContext>;
  /** Task-level override, else the nearest entity's first matching assignment. */
  resolve(db: Db, id: string, context: SopContext): Promise<Resolution | null>;
  /** May this SOP run against this subject (`actorId` = who is attaching it, if anyone)? */
  canUseSop(db: Db, id: string, sopId: string, actorId?: string): Promise<boolean>;
  statuses: readonly IssueStatus[];
  setStatus(db: Db, id: string, status: IssueStatus): Promise<void>;
  setLabels(db: Db, id: string, labels: string[]): Promise<void>;
  setField(db: Db, id: string, key: string, value: Prisma.InputJsonValue | null): Promise<void>;
  recipients(db: Db, id: string, kinds: NotifyRecipient[], userIds: string[]): Promise<string[]>;
  /** The user's role for approver checks; null when they can't approve at all. */
  approverRole(db: Db, id: string, userId: string): Promise<WorkspaceRole | null>;
  /** Users whose own work this is (for `preventSelfApproval`). */
  workerIds(db: Db, id: string): Promise<string[]>;
  /** Display info for notifications. */
  describe(db: Db, id: string): Promise<{ title: string; key: string; workspaceId: string | null; issueId: string | null }>;
}

const asFields = (value: Prisma.JsonValue | null | undefined): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

async function firstMatchingAssignment(
  db: Db,
  where: Prisma.SopAssignmentWhereInput,
  context: SopContext,
  scope: { type: AssignmentScopeType; id: string; name: string }
): Promise<Resolution | null> {
  const assignments = await db.sopAssignment.findMany({
    where,
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  });
  const match = assignments.find((a) => evaluateCondition(a.condition, context));
  return match
    ? {
        sopId: match.sopId,
        assignmentType: "ENTITY_INHERITED",
        source: { kind: "ASSIGNMENT", assignmentId: match.id, scopeType: scope.type, scopeId: scope.id, scopeName: scope.name },
      }
    : null;
}

async function withFieldUpdate<T extends { customFields: Prisma.JsonValue }>(
  current: T | null,
  key: string,
  value: Prisma.InputJsonValue | null
) {
  const fields = { ...asFields(current?.customFields) };
  if (value === null) delete fields[key];
  else fields[key] = value;
  return fields as Prisma.InputJsonObject;
}

// ---------------------------------------------------------------------------
// Issues (workspace tracker). Entity = component, then project.
// ---------------------------------------------------------------------------
const issueAdapter: SubjectAdapter = {
  async canAccess(db, userId, id) {
    return !!(await db.issue.findFirst({ where: { id, workspace: { members: { some: { userId } } } }, select: { id: true } }));
  },
  async loadContext(db, id) {
    const issue = await db.issue.findUniqueOrThrow({
      where: { id },
      include: { component: { select: { id: true, name: true } }, project: { select: { id: true, key: true, name: true } } },
    });
    return {
      subject: { type: "ISSUE", id },
      issue: {
        id: issue.id, key: issue.key, title: issue.title, type: issue.type, status: issue.status,
        priority: issue.priority, labels: issue.labels, componentId: issue.componentId,
        projectId: issue.projectId, storyPoints: issue.storyPoints, assigneeId: issue.assigneeId,
        reporterId: issue.reporterId, dueDate: issue.dueDate?.toISOString() ?? null,
      },
      entity: issue.component
        ? { kind: "COMPONENT", id: issue.component.id, name: issue.component.name, project: issue.project.key }
        : { kind: "PROJECT", id: issue.project.id, name: issue.project.name, project: issue.project.key },
      fields: asFields(issue.customFields),
    };
  },
  async resolve(db, id, context) {
    const issue = await db.issue.findUniqueOrThrow({
      where: { id },
      select: { sopOverrideId: true, componentId: true, projectId: true, component: { select: { name: true } }, project: { select: { name: true } } },
    });
    if (issue.sopOverrideId) return { sopId: issue.sopOverrideId, assignmentType: "TASK_OVERRIDE", source: { kind: "OVERRIDE" } };
    if (issue.componentId) {
      const fromComponent = await firstMatchingAssignment(db, { componentId: issue.componentId }, context, {
        type: "COMPONENT", id: issue.componentId, name: issue.component?.name ?? "",
      });
      if (fromComponent) return fromComponent;
    }
    return firstMatchingAssignment(db, { projectId: issue.projectId }, context, {
      type: "PROJECT", id: issue.projectId, name: issue.project.name,
    });
  },
  async canUseSop(db, id, sopId, actorId) {
    const issue = await db.issue.findUniqueOrThrow({ where: { id }, select: { workspaceId: true } });
    const sop = await db.sop.findUnique({ where: { id: sopId }, select: { workspaceId: true, userId: true } });
    if (!sop) return false;
    // Shared into the issue's workspace, or (manual attach only) the actor's own SOP.
    return sop.workspaceId === issue.workspaceId || (!!actorId && sop.userId === actorId && sop.workspaceId === null);
  },
  statuses: ["BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "DONE", "CANCELLED"],
  async setStatus(db, id, status) {
    await db.issue.update({ where: { id }, data: { status, resolvedAt: status === "DONE" ? new Date() : null } });
  },
  async setLabels(db, id, labels) {
    await db.issue.update({ where: { id }, data: { labels } });
  },
  async setField(db, id, key, value) {
    const current = await db.issue.findUnique({ where: { id }, select: { customFields: true } });
    await db.issue.update({ where: { id }, data: { customFields: await withFieldUpdate(current, key, value) } });
  },
  async recipients(db, id, kinds, userIds) {
    const issue = await db.issue.findUniqueOrThrow({
      where: { id },
      select: { workspaceId: true, assigneeId: true, reporterId: true, watchers: { select: { userId: true } } },
    });
    const ids = new Set<string>();
    if (kinds.includes("ASSIGNEE") && issue.assigneeId) ids.add(issue.assigneeId);
    if (kinds.includes("REPORTER") || kinds.includes("OWNER")) ids.add(issue.reporterId);
    if (kinds.includes("WATCHERS")) issue.watchers.forEach((w) => ids.add(w.userId));
    userIds.forEach((u) => ids.add(u));
    // Never notify outside the workspace, whatever the rule says.
    const members = await db.workspaceMember.findMany({
      where: { workspaceId: issue.workspaceId, userId: { in: [...ids] } },
      select: { userId: true },
    });
    return members.map((m) => m.userId);
  },
  async approverRole(db, id, userId) {
    const issue = await db.issue.findUniqueOrThrow({ where: { id }, select: { workspaceId: true } });
    const member = await db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: issue.workspaceId, userId } } });
    return member?.role ?? null;
  },
  async workerIds(db, id) {
    const issue = await db.issue.findUniqueOrThrow({ where: { id }, select: { assigneeId: true } });
    return issue.assigneeId ? [issue.assigneeId] : [];
  },
  async describe(db, id) {
    const issue = await db.issue.findUniqueOrThrow({ where: { id }, select: { title: true, key: true, workspaceId: true } });
    return { title: issue.title, key: issue.key, workspaceId: issue.workspaceId, issueId: id };
  },
};

// ---------------------------------------------------------------------------
// Notes (the Module → Sub-module → Ticket tree). Entity = the top-level module;
// SOP assignments are inherited from the nearest ancestor that has any.
// ---------------------------------------------------------------------------

/** Ancestors of a note, nearest first (excluding the note itself). */
export async function noteAncestors(db: Db, noteId: string) {
  return db.$queryRaw<{ id: string; title: string; depth: number }[]>`
    WITH RECURSIVE ancestors AS (
      SELECT p."id", p."title", p."parentId", 1 AS depth
      FROM "notes" n JOIN "notes" p ON p."id" = n."parentId"
      WHERE n."id" = ${noteId}
      UNION ALL
      SELECT p."id", p."title", p."parentId", a.depth + 1
      FROM "notes" p JOIN ancestors a ON p."id" = a."parentId"
      WHERE a.depth < 50
    )
    SELECT "id", "title", depth::int AS depth FROM ancestors ORDER BY depth ASC
  `;
}

export const noteKey = (id: string) => `LN-${id.slice(-5).toUpperCase()}`;

const noteAdapter: SubjectAdapter = {
  async canAccess(db, userId, id) {
    return !!(await db.note.findFirst({ where: { id, userId }, select: { id: true } }));
  },
  async loadContext(db, id) {
    const note = await db.note.findUniqueOrThrow({ where: { id } });
    const ancestors = await noteAncestors(db, id);
    const root = ancestors.at(-1);
    const item = {
      id: note.id, key: noteKey(note.id), title: note.title, type: null, status: note.status,
      priority: note.priority, labels: note.labels, depth: ancestors.length,
    };
    return {
      subject: { type: "NOTE", id },
      issue: item,
      note: item,
      parent: ancestors[0] ? { id: ancestors[0].id, title: ancestors[0].title } : null,
      entity: root ? { kind: "MODULE", id: root.id, name: root.title } : { kind: "MODULE", id: note.id, name: note.title },
      fields: asFields(note.customFields),
    };
  },
  async resolve(db, id, context) {
    const note = await db.note.findUniqueOrThrow({ where: { id }, select: { sopOverrideId: true } });
    if (note.sopOverrideId) return { sopId: note.sopOverrideId, assignmentType: "TASK_OVERRIDE", source: { kind: "OVERRIDE" } };
    for (const ancestor of await noteAncestors(db, id)) {
      const match = await firstMatchingAssignment(db, { noteId: ancestor.id }, context, {
        type: "NOTE", id: ancestor.id, name: ancestor.title,
      });
      if (match) return match;
    }
    return null;
  },
  async canUseSop(db, id, sopId) {
    const note = await db.note.findUniqueOrThrow({ where: { id }, select: { userId: true } });
    return !!(await db.sop.findFirst({
      where: { id: sopId, OR: [{ userId: note.userId }, { workspace: { members: { some: { userId: note.userId } } } }] },
      select: { id: true },
    }));
  },
  statuses: ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"],
  async setStatus(db, id, status) {
    await db.note.update({ where: { id }, data: { status } });
  },
  async setLabels(db, id, labels) {
    await db.note.update({ where: { id }, data: { labels: labels.slice(0, 20) } });
  },
  async setField(db, id, key, value) {
    const current = await db.note.findUnique({ where: { id }, select: { customFields: true } });
    await db.note.update({ where: { id }, data: { customFields: await withFieldUpdate(current, key, value) } });
  },
  async recipients(db, id) {
    // Notes are private to their owner; nobody else can be notified about them.
    const note = await db.note.findUniqueOrThrow({ where: { id }, select: { userId: true } });
    return [note.userId];
  },
  async approverRole(db, id, userId) {
    const note = await db.note.findUniqueOrThrow({ where: { id }, select: { userId: true } });
    return note.userId === userId ? "OWNER" : null;
  },
  async workerIds() {
    return [];
  },
  async describe(db, id) {
    const note = await db.note.findUniqueOrThrow({ where: { id }, select: { title: true } });
    return { title: note.title, key: noteKey(id), workspaceId: null, issueId: null };
  },
};

// ---------------------------------------------------------------------------
// Personal tasks. No entity, so only the task-level override applies.
// ---------------------------------------------------------------------------
const taskAdapter: SubjectAdapter = {
  async canAccess(db, userId, id) {
    return !!(await db.task.findFirst({ where: { id, userId }, select: { id: true } }));
  },
  async loadContext(db, id) {
    const task = await db.task.findUniqueOrThrow({ where: { id } });
    const item = { id: task.id, title: task.title, status: task.status, dueDate: task.dueDate?.toISOString() ?? null };
    return {
      subject: { type: "TASK", id },
      task: item,
      issue: { ...item, type: null, priority: null, labels: [] },
      entity: null,
      fields: asFields(task.customFields),
    };
  },
  async resolve(db, id) {
    const task = await db.task.findUniqueOrThrow({ where: { id }, select: { sopOverrideId: true } });
    return task.sopOverrideId ? { sopId: task.sopOverrideId, assignmentType: "TASK_OVERRIDE", source: { kind: "OVERRIDE" } } : null;
  },
  async canUseSop(db, id, sopId) {
    const task = await db.task.findUniqueOrThrow({ where: { id }, select: { userId: true } });
    return !!(await db.sop.findFirst({
      where: { id: sopId, OR: [{ userId: task.userId }, { workspace: { members: { some: { userId: task.userId } } } }] },
      select: { id: true },
    }));
  },
  statuses: ["TODO", "IN_PROGRESS", "DONE"],
  async setStatus(db, id, status) {
    await db.task.update({ where: { id }, data: { status: status as "TODO" | "IN_PROGRESS" | "DONE" } });
  },
  async setLabels() {
    // Tasks have no labels; the action is a no-op.
  },
  async setField(db, id, key, value) {
    const current = await db.task.findUnique({ where: { id }, select: { customFields: true } });
    await db.task.update({ where: { id }, data: { customFields: await withFieldUpdate(current, key, value) } });
  },
  async recipients(db, id) {
    const task = await db.task.findUniqueOrThrow({ where: { id }, select: { userId: true } });
    return [task.userId];
  },
  async approverRole(db, id, userId) {
    const task = await db.task.findUniqueOrThrow({ where: { id }, select: { userId: true } });
    return task.userId === userId ? "OWNER" : null;
  },
  async workerIds() {
    return [];
  },
  async describe(db, id) {
    const task = await db.task.findUniqueOrThrow({ where: { id }, select: { title: true } });
    return { title: task.title, key: "TASK", workspaceId: null, issueId: null };
  },
};

export const SUBJECT_ADAPTERS: Record<SubjectType, SubjectAdapter> = {
  ISSUE: issueAdapter,
  NOTE: noteAdapter,
  TASK: taskAdapter,
};
