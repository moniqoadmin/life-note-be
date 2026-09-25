import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody } from "@/lib/api";
import { updateIssueSchema } from "@/lib/validation";
import { canManageWorkspace, getMembership } from "@/lib/workspaces";
import {
  activityValue,
  getAccessibleIssue,
  getIssueDetail,
  recordActivity,
  validateIssueRefs,
} from "@/lib/issues";
import { createNotifications, sendPendingEmails } from "@/lib/notifications";

type Params = { params: Promise<{ issueId: string }> };

/**
 * @swagger
 * /issues/{issueId}:
 *   get:
 *     tags: [Issues]
 *     summary: Get an issue
 *     description: Everything the issue page renders — details panel, sub-tasks, acceptance criteria, relations, runbooks with step progress, dev links, watchers and time tracking. Comments, work logs, attachments and history are paginated separately.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/IssueId' }]
 *     responses:
 *       200:
 *         description: The issue.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 issue: { $ref: '#/components/schemas/IssueDetail' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   patch:
 *     tags: [Issues]
 *     summary: Update an issue
 *     description: >-
 *       Any subset of fields. Status changes drive "Move to Review" (IN_REVIEW) and "Mark Done" (DONE);
 *       DONE sets resolvedAt. Changing status without a position moves the issue to the end of its new
 *       column. Every changed field is recorded in the issue's history. A new assignee (other than the
 *       caller) is notified.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/IssueId' }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               type: { type: string, enum: [STORY, TASK, BUG, SECURITY, SPIKE] }
 *               title: { type: string }
 *               description: { type: string }
 *               status: { type: string, enum: [BACKLOG, TODO, IN_PROGRESS, IN_REVIEW, DONE, CANCELLED] }
 *               priority: { type: string, enum: [URGENT, HIGH, MEDIUM, LOW, NONE] }
 *               storyPoints: { type: integer, nullable: true }
 *               labels: { type: array, items: { type: string }, description: Replaces the whole list. }
 *               position: { type: number, description: Board order within the status column (drag and drop). }
 *               estimateMinutes: { type: integer, nullable: true }
 *               dueDate: { type: string, format: date-time, nullable: true }
 *               slaDueAt: { type: string, format: date-time, nullable: true }
 *               assigneeId: { type: string, nullable: true }
 *               parentId: { type: string, nullable: true }
 *               componentId: { type: string, nullable: true }
 *               epicId: { type: string, nullable: true }
 *               sprintId: { type: string, nullable: true }
 *               releaseId: { type: string, nullable: true }
 *     responses:
 *       200:
 *         description: The updated issue.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 issue: { $ref: '#/components/schemas/IssueDetail' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Issues]
 *     summary: Delete an issue
 *     description: Reporter, OWNER or ADMIN only. Also deletes its sub-tasks, comments, work logs, attachments and runbooks.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/IssueId' }]
 *     responses:
 *       200: { $ref: '#/components/responses/Deleted' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { issueId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return NextResponse.json({ error: "Issue not found" }, { status: 404 });
  }

  const issue = await getIssueDetail(userId, issueId);
  return NextResponse.json({ issue });
}

export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { issueId } = await params;

  const existing = await getAccessibleIssue(userId, issueId);
  if (!existing) {
    return NextResponse.json({ error: "Issue not found" }, { status: 404 });
  }

  const parsed = await parseJsonBody(req, updateIssueSchema);
  if (!parsed.success) return parsed.response;
  const changes = parsed.data;

  const refError = await validateIssueRefs(
    existing.workspaceId,
    existing.projectId,
    changes,
    issueId
  );
  if (refError) {
    return NextResponse.json({ error: refError }, { status: 400 });
  }

  const data: Prisma.IssueUncheckedUpdateInput = { ...changes };
  const statusChanged = changes.status !== undefined && changes.status !== existing.status;
  if (statusChanged) {
    data.resolvedAt = changes.status === "DONE" ? new Date() : null;
  }

  const emails = await prisma.$transaction(async (tx) => {
    if (statusChanged && changes.position === undefined) {
      const last = await tx.issue.aggregate({
        where: { projectId: existing.projectId, status: changes.status },
        _max: { position: true },
      });
      data.position = (last._max.position ?? 0) + 1;
    }

    const updated = await tx.issue.update({ where: { id: issueId }, data });

    // Board reordering is noise in the history; everything else is recorded.
    for (const [field, to] of Object.entries(changes)) {
      if (field === "position") continue;
      const from = existing[field as keyof typeof existing];
      if (JSON.stringify(activityValue(from)) === JSON.stringify(activityValue(to))) continue;
      await recordActivity(tx, issueId, userId, "FIELD_CHANGED", {
        field,
        from: activityValue(from),
        to: activityValue(to),
      });
    }

    if (changes.assigneeId && changes.assigneeId !== existing.assigneeId) {
      await tx.issueWatcher.createMany({
        data: [{ issueId, userId: changes.assigneeId }],
        skipDuplicates: true,
      });
      return createNotifications(tx, {
        type: "ASSIGNED",
        recipientIds: [changes.assigneeId],
        actorId: userId,
        issue: updated,
      });
    }
    return [];
  });

  await sendPendingEmails(emails);

  const issue = await getIssueDetail(userId, issueId);
  return NextResponse.json({ issue });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { issueId } = await params;

  const existing = await getAccessibleIssue(userId, issueId);
  if (!existing) {
    return NextResponse.json({ error: "Issue not found" }, { status: 404 });
  }
  if (existing.reporterId !== userId) {
    const membership = await getMembership(userId, existing.workspaceId);
    if (!membership || !canManageWorkspace(membership.role)) {
      return NextResponse.json(
        { error: "Only the reporter, owners and admins can delete an issue" },
        { status: 403 }
      );
    }
  }

  await prisma.issue.delete({ where: { id: issueId } });

  return NextResponse.json({ message: "Issue deleted" });
}
