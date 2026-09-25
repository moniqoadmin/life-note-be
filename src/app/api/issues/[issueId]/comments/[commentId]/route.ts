import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody } from "@/lib/api";
import { updateCommentSchema } from "@/lib/validation";
import { canManageWorkspace, getMembership, userSelect } from "@/lib/workspaces";
import { getAccessibleIssue } from "@/lib/issues";
import {
  commentExcerpt,
  createNotifications,
  extractMentionIds,
  sendPendingEmails,
} from "@/lib/notifications";

type Params = { params: Promise<{ issueId: string; commentId: string }> };

/**
 * @swagger
 * /issues/{issueId}/comments/{commentId}:
 *   patch:
 *     tags: [Issue details]
 *     summary: Edit a comment
 *     description: Author only. Sets editedAt. Only people newly mentioned by the edit are notified.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/IssueId'
 *       - { in: path, name: commentId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [body]
 *             properties:
 *               body: { type: string }
 *     responses:
 *       200:
 *         description: The updated comment.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 comment: { $ref: '#/components/schemas/IssueComment' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Issue details]
 *     summary: Delete a comment
 *     description: Author, OWNER or ADMIN. Replies are deleted with it.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/IssueId'
 *       - { in: path, name: commentId, required: true, schema: { type: string } }
 *     responses:
 *       200: { $ref: '#/components/responses/Deleted' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { issueId, commentId } = await params;

  const issue = await getAccessibleIssue(userId, issueId);
  if (!issue) {
    return NextResponse.json({ error: "Issue not found" }, { status: 404 });
  }
  const existing = await prisma.issueComment.findFirst({ where: { id: commentId, issueId } });
  if (!existing) {
    return NextResponse.json({ error: "Comment not found" }, { status: 404 });
  }
  if (existing.authorId !== userId) {
    return NextResponse.json({ error: "Only the author can edit a comment" }, { status: 403 });
  }

  const parsed = await parseJsonBody(req, updateCommentSchema);
  if (!parsed.success) return parsed.response;

  const { body } = parsed.data;

  const alreadyMentioned = new Set(extractMentionIds(existing.body));
  const newMentionIds = extractMentionIds(body).filter((id) => !alreadyMentioned.has(id));
  const excerpt = newMentionIds.length > 0 ? await commentExcerpt(body) : undefined;

  const { comment, emails } = await prisma.$transaction(async (tx) => {
    const updated = await tx.issueComment.update({
      where: { id: commentId },
      data: { body, editedAt: new Date() },
      include: { author: { select: userSelect } },
    });
    const pending = await createNotifications(tx, {
      type: "MENTION",
      recipientIds: newMentionIds,
      actorId: userId,
      issue,
      commentId,
      excerpt,
    });
    return { comment: updated, emails: pending };
  });

  await sendPendingEmails(emails);

  return NextResponse.json({ comment });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { issueId, commentId } = await params;

  const issue = await getAccessibleIssue(userId, issueId);
  if (!issue) {
    return NextResponse.json({ error: "Issue not found" }, { status: 404 });
  }
  const existing = await prisma.issueComment.findFirst({ where: { id: commentId, issueId } });
  if (!existing) {
    return NextResponse.json({ error: "Comment not found" }, { status: 404 });
  }
  if (existing.authorId !== userId) {
    const membership = await getMembership(userId, issue.workspaceId);
    if (!membership || !canManageWorkspace(membership.role)) {
      return NextResponse.json(
        { error: "Only the author, owners and admins can delete a comment" },
        { status: 403 }
      );
    }
  }

  await prisma.issueComment.delete({ where: { id: commentId } });

  return NextResponse.json({ message: "Comment deleted" });
}
