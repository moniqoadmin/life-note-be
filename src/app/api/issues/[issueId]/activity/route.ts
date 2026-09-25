import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { paginationSchema } from "@/lib/validation";
import { userSelect } from "@/lib/workspaces";
import { getAccessibleIssue, queryToObject } from "@/lib/issues";

type Params = { params: Promise<{ issueId: string }> };

/**
 * @swagger
 * /issues/{issueId}/activity:
 *   get:
 *     tags: [Issue details]
 *     summary: Issue history / audit trail
 *     description: >-
 *       Append-only log of everything that happened to the issue — the "History" tab. Covers creation,
 *       every field change (status, assignee, sprint, …), comments, work logged, attachments, relations,
 *       runbook steps and dev links. Newest first.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/IssueId'
 *       - $ref: '#/components/parameters/Limit'
 *       - $ref: '#/components/parameters/Offset'
 *     responses:
 *       200:
 *         description: Activity entries.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 activities: { type: array, items: { $ref: '#/components/schemas/IssueActivity' } }
 *                 total: { type: integer }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function GET(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { issueId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return NextResponse.json({ error: "Issue not found" }, { status: 404 });
  }

  const page = paginationSchema.safeParse(queryToObject(new URL(req.url).searchParams));
  if (!page.success) {
    return NextResponse.json({ error: "Invalid pagination" }, { status: 400 });
  }

  const [activities, total] = await Promise.all([
    prisma.issueActivity.findMany({
      where: { issueId },
      orderBy: { createdAt: "desc" },
      include: { actor: { select: userSelect } },
      take: page.data.limit,
      skip: page.data.offset,
    }),
    prisma.issueActivity.count({ where: { issueId } }),
  ]);

  return NextResponse.json({ activities, total });
}
