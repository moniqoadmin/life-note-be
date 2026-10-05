import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, apiError } from "@/lib/api";
import { createCommentSchema, paginationSchema } from "@/lib/validation";
import { userSelect } from "@/lib/workspaces";
import { getAccessibleIssue, queryToObject, recordActivity } from "@/lib/issues";
import {
  commentExcerpt,
  createNotifications,
  extractMentionIds,
  sendPendingEmails,
} from "@/lib/notifications";

type Params = { params: Promise<{ issueId: string }> };

/**
 * @swagger
 * /issues/{issueId}/comments:
 *   get:
 *     tags: [Issue details]
 *     summary: List comments
 *     description: Oldest first. Replies carry parentId; thread them client-side.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/IssueId'
 *       - $ref: '#/components/parameters/Limit'
 *       - $ref: '#/components/parameters/Offset'
 *     responses:
 *       200:
 *         description: The comments.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 comments: { type: array, items: { $ref: '#/components/schemas/IssueComment' } }
 *                 total: { type: integer }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   post:
 *     tags: [Issue details]
 *     summary: Add a comment
 *     description: >-
 *       Markdown body. Mention people with `<@userId>` tokens (render them as @Name) — each mentioned
 *       workspace member gets an in-app notification and an email. Pass parentId to reply to another
 *       comment on the same issue. The author starts watching the issue.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/IssueId' }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [body]
 *             properties:
 *               body: { type: string }
 *               parentId: { type: string, nullable: true }
 *     responses:
 *       201:
 *         description: The created comment.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 comment: { $ref: '#/components/schemas/IssueComment' }
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
  const { issueId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return apiError(404, "Issue not found");
  }

  const page = paginationSchema.safeParse(queryToObject(new URL(req.url).searchParams));
  if (!page.success) {
    return apiError(400, "Invalid pagination");
  }

  const [comments, total] = await Promise.all([
    prisma.issueComment.findMany({
      where: { issueId },
      orderBy: { createdAt: "asc" },
      include: { author: { select: userSelect } },
      take: page.data.limit,
      skip: page.data.offset,
    }),
    prisma.issueComment.count({ where: { issueId } }),
  ]);

  return NextResponse.json({ comments, total });
}

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { issueId } = await params;

  const issue = await getAccessibleIssue(userId, issueId);
  if (!issue) {
    return apiError(404, "Issue not found");
  }

  const parsed = await parseJsonBody(req, createCommentSchema);
  if (!parsed.success) return parsed.response;
  const { body, parentId } = parsed.data;

  if (parentId) {
    const parent = await prisma.issueComment.findFirst({ where: { id: parentId, issueId } });
    if (!parent) {
      return apiError(400, "Parent comment not found");
    }
  }

  const mentionIds = extractMentionIds(body);
  const excerpt = mentionIds.length > 0 ? await commentExcerpt(body) : undefined;

  const { comment, emails } = await prisma.$transaction(async (tx) => {
    const created = await tx.issueComment.create({
      data: { issueId, authorId: userId, body, parentId: parentId ?? null },
      include: { author: { select: userSelect } },
    });
    await tx.issueWatcher.createMany({ data: [{ issueId, userId }], skipDuplicates: true });
    await recordActivity(tx, issueId, userId, "COMMENT_ADDED", { commentId: created.id });
    const pending = await createNotifications(tx, {
      type: "MENTION",
      recipientIds: mentionIds,
      actorId: userId,
      issue,
      commentId: created.id,
      excerpt,
    });
    return { comment: created, emails: pending };
  });

  await sendPendingEmails(emails);

  return NextResponse.json({ comment }, { status: 201 });
}
