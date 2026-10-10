import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api";
import { userSelect } from "@/lib/workspaces";
import { isEngineError } from "@/lib/sop/engine";
import { SUBJECT_ADAPTERS, subjectOf, subjectWhere, type SubjectRef } from "@/lib/sop/subjects";

export const executionInclude = {
  sop: { select: { id: true, title: true, version: true, publishedVersion: true } },
  events: { orderBy: { createdAt: "asc" }, include: { actor: { select: userSelect } } },
  steps: {
    orderBy: { position: "asc" },
    include: {
      completedBy: { select: userSelect },
      approvals: { orderBy: { createdAt: "asc" }, include: { user: { select: userSelect } } },
    },
  },
} satisfies Prisma.IssueRunbookInclude;

export type ExecutionWithSteps = Prisma.IssueRunbookGetPayload<{ include: typeof executionInclude }>;

/**
 * API shape of an execution: the row plus `subject`, `progress`, where its SOP came
 * from (`assignment`) and whether a newer published SOP version exists.
 */
export function serializeExecution(execution: ExecutionWithSteps) {
  const total = execution.steps.length;
  const completed = execution.steps.filter((s) => s.status === "VERIFIED" || s.status === "SKIPPED").length;
  const sourceEvent = [...execution.events]
    .reverse()
    .find((e) => e.type === "ASSIGNMENT_CHANGED" || e.type === "EXECUTION_CREATED");
  const source = (sourceEvent?.data as { source?: unknown } | null)?.source ?? null;
  const latest = execution.sop ? execution.sop.publishedVersion ?? execution.sop.version : null;
  return {
    ...execution,
    subject: subjectOf(execution),
    assignment: { type: execution.assignmentType ?? "MANUAL", source },
    updateAvailable: latest !== null && latest > execution.sopVersion,
    progress: {
      completed,
      total,
      percent: total === 0 ? 100 : Math.round((completed / total) * 100),
      currentStepId: execution.currentStepId,
    },
  };
}

export async function getExecution(id: string) {
  const execution = await prisma.issueRunbook.findUnique({ where: { id }, include: executionInclude });
  return execution && serializeExecution(execution);
}

export async function listSubjectExecutions(subject: SubjectRef) {
  const executions = await prisma.issueRunbook.findMany({
    where: subjectWhere(subject),
    orderBy: { createdAt: "asc" },
    include: executionInclude,
  });
  return executions.map(serializeExecution);
}

/** The execution, if `userId` can access its subject; null otherwise (treat as 404). */
export async function getAccessibleExecution(userId: string, id: string) {
  const execution = await prisma.issueRunbook.findUnique({
    where: { id },
    select: { id: true, issueId: true, noteId: true, taskId: true },
  });
  if (!execution) return null;
  const subject = subjectOf(execution);
  return (await SUBJECT_ADAPTERS[subject.type].canAccess(prisma, userId, subject.id)) ? { ...execution, subject } : null;
}

/** Turns engine errors into API errors; rethrows anything else. */
export function engineErrorResponse(error: unknown) {
  if (isEngineError(error)) return apiError(error.status, error.message);
  throw error;
}
