import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, apiError, validationError } from "@/lib/api";
import { createIssueSchema, listIssuesQuerySchema } from "@/lib/validation";
import { getAccessibleProject } from "@/lib/workspaces";
import {
  buildIssueWhere,
  getIssueDetail,
  issueListInclude,
  issueOrderBy,
  queryToObject,
  recordActivity,
  validateIssueRefs,
} from "@/lib/issues";
import { createNotifications, sendPendingEmails } from "@/lib/notifications";
import { ENGINE_TX_OPTIONS, syncIssueAssignment } from "@/lib/sop-engine";

type Params = { params: Promise<{ projectId: string }> };

/**
 * @swagger
 * /projects/{projectId}/issues:
 *   get:
 *     tags: [Issues]
 *     summary: List a project's issues
 *     description: Powers the board, list and backlog views. For a board, request sort=position and group by status client-side.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/ProjectId'
 *       - { in: query, name: status, schema: { type: string, enum: [BACKLOG, TODO, IN_PROGRESS, IN_REVIEW, DONE, CANCELLED] } }
 *       - { in: query, name: type, schema: { type: string, enum: [STORY, TASK, BUG, SECURITY, SPIKE] }, description: "Use BUG for the \"Bugs only\" filter." }
 *       - { in: query, name: priority, schema: { type: string, enum: [URGENT, HIGH, MEDIUM, LOW, NONE] } }
 *       - { in: query, name: assigneeId, schema: { type: string }, description: "A user id, \"me\" (\"Only my issues\") or \"none\" (unassigned)." }
 *       - { in: query, name: reporterId, schema: { type: string }, description: "A user id or \"me\"." }
 *       - { in: query, name: parentId, schema: { type: string }, description: "A parent issue id, or \"none\" for top-level issues only (hides sub-tasks)." }
 *       - { in: query, name: componentId, schema: { type: string }, description: "A component id or \"none\"." }
 *       - { in: query, name: epicId, schema: { type: string }, description: "An epic id or \"none\"." }
 *       - { in: query, name: sprintId, schema: { type: string }, description: "A sprint id, or \"none\" for the backlog." }
 *       - { in: query, name: releaseId, schema: { type: string }, description: "A release id or \"none\"." }
 *       - { in: query, name: label, schema: { type: string } }
 *       - { in: query, name: q, schema: { type: string }, description: Case-insensitive match on key or title. }
 *       - { in: query, name: updatedSince, schema: { type: string, format: date-time }, description: "For the \"Recently updated\" filter." }
 *       - { in: query, name: sort, schema: { type: string, enum: [updated, created, position, priority], default: updated }, description: Use position for board columns. }
 *       - $ref: '#/components/parameters/Limit'
 *       - $ref: '#/components/parameters/Offset'
 *     responses:
 *       200:
 *         description: Matching issues.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 issues: { type: array, items: { $ref: '#/components/schemas/IssueListItem' } }
 *                 total: { type: integer, description: Total matches, ignoring limit/offset. }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   post:
 *     tags: [Issues]
 *     summary: Create an issue
 *     description: Assigns the next key in the project (e.g. AUTH-105). The caller becomes reporter; reporter and assignee are added as watchers, and the assignee (if not the caller) is notified. Pass parentId to create a sub-task.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/ProjectId' }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title]
 *             properties:
 *               type: { type: string, enum: [STORY, TASK, BUG, SECURITY, SPIKE] }
 *               title: { type: string }
 *               description: { type: string, description: Markdown. }
 *               status: { type: string, enum: [BACKLOG, TODO, IN_PROGRESS, IN_REVIEW, DONE, CANCELLED] }
 *               priority: { type: string, enum: [URGENT, HIGH, MEDIUM, LOW, NONE] }
 *               storyPoints: { type: integer, nullable: true }
 *               labels: { type: array, items: { type: string } }
 *               estimateMinutes: { type: integer, nullable: true, description: Original time estimate. }
 *               dueDate: { type: string, format: date-time, nullable: true }
 *               slaDueAt: { type: string, format: date-time, nullable: true, description: SLA deadline (e.g. first fix). }
 *               assigneeId: { type: string, nullable: true, description: Must be a workspace member. }
 *               parentId: { type: string, nullable: true, description: Makes this a sub-task of an issue in the same project. }
 *               componentId: { type: string, nullable: true }
 *               epicId: { type: string, nullable: true }
 *               sprintId: { type: string, nullable: true }
 *               releaseId: { type: string, nullable: true, description: Fix version. }
 *     responses:
 *       201:
 *         description: The created issue.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 issue: { $ref: '#/components/schemas/IssueDetail' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function GET(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { projectId } = await params;

  if (!(await getAccessibleProject(userId, projectId))) {
    return apiError(404, "Project not found");
  }

  const query = listIssuesQuerySchema.safeParse(queryToObject(new URL(req.url).searchParams));
  if (!query.success) {
    return validationError(query.error);
  }

  const where = { ...buildIssueWhere(userId, query.data), projectId };
  const [issues, total] = await Promise.all([
    prisma.issue.findMany({
      where,
      orderBy: issueOrderBy(query.data.sort),
      include: issueListInclude,
      take: query.data.limit,
      skip: query.data.offset,
    }),
    prisma.issue.count({ where }),
  ]);

  return NextResponse.json({ issues, total });
}

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { projectId } = await params;

  const project = await getAccessibleProject(userId, projectId);
  if (!project) {
    return apiError(404, "Project not found");
  }

  const parsed = await parseJsonBody(req, createIssueSchema);
  if (!parsed.success) return parsed.response;
  const data = parsed.data;

  const refError = await validateIssueRefs(project.workspaceId, projectId, data);
  if (refError) {
    return apiError(400, refError);
  }

  const { issueId, emails } = await prisma.$transaction(async (tx) => {
    // Row-locks the project for the rest of the transaction, so concurrent creates
    // get distinct sequential numbers.
    const { issueCounter, key } = await tx.project.update({
      where: { id: projectId },
      data: { issueCounter: { increment: 1 } },
      select: { issueCounter: true, key: true },
    });
    const last = await tx.issue.aggregate({
      where: { projectId, status: data.status },
      _max: { position: true },
    });

    const issue = await tx.issue.create({
      data: {
        workspaceId: project.workspaceId,
        projectId,
        number: issueCounter,
        key: `${key}-${issueCounter}`,
        reporterId: userId,
        position: (last._max.position ?? 0) + 1,
        resolvedAt: data.status === "DONE" ? new Date() : null,
        type: data.type,
        title: data.title,
        description: data.description,
        status: data.status,
        priority: data.priority,
        labels: data.labels,
        storyPoints: data.storyPoints ?? null,
        estimateMinutes: data.estimateMinutes ?? null,
        dueDate: data.dueDate ?? null,
        slaDueAt: data.slaDueAt ?? null,
        assigneeId: data.assigneeId ?? null,
        parentId: data.parentId ?? null,
        componentId: data.componentId ?? null,
        epicId: data.epicId ?? null,
        sprintId: data.sprintId ?? null,
        releaseId: data.releaseId ?? null,
        sopOverrideId: data.sopOverrideId ?? null,
        customFields: data.customFields,
      },
    });

    const watcherIds = [...new Set([userId, data.assigneeId].filter((id): id is string => !!id))];
    await tx.issueWatcher.createMany({
      data: watcherIds.map((id) => ({ issueId: issue.id, userId: id })),
      skipDuplicates: true,
    });
    await recordActivity(tx, issue.id, userId, "CREATED", { key: issue.key });

    // Task-level override → component (entity) default SOP → none; starts the execution.
    await syncIssueAssignment(tx, issue.id, userId);

    const pending = data.assigneeId
      ? await createNotifications(tx, {
          type: "ASSIGNED",
          recipientIds: [data.assigneeId],
          actorId: userId,
          issue,
        })
      : [];

    return { issueId: issue.id, emails: pending };
  }, ENGINE_TX_OPTIONS);

  await sendPendingEmails(emails);

  const issue = await getIssueDetail(userId, issueId);
  return NextResponse.json({ issue }, { status: 201 });
}
