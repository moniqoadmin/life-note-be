import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { userSelect } from "@/lib/workspaces";
import { getAccessibleIssue } from "@/lib/issues";

type Params = { params: Promise<{ issueId: string }> };

/**
 * @swagger
 * /issues/{issueId}/watchers:
 *   get:
 *     tags: [Issue details]
 *     summary: List watchers
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/IssueId' }]
 *     responses:
 *       200:
 *         description: Users watching the issue.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 watchers: { type: array, items: { $ref: '#/components/schemas/User' } }
 *                 isWatching: { type: boolean }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   post:
 *     tags: [Issue details]
 *     summary: Watch an issue
 *     description: Adds the caller as a watcher. Idempotent.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/IssueId' }]
 *     responses:
 *       200:
 *         description: Watching.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 isWatching: { type: boolean, example: true }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Issue details]
 *     summary: Stop watching an issue
 *     description: Removes the caller as a watcher. Idempotent.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/IssueId' }]
 *     responses:
 *       200:
 *         description: Not watching.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 isWatching: { type: boolean, example: false }
 *       401: { $ref: '#/components/responses/Unauthorized' }
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

  const rows = await prisma.issueWatcher.findMany({
    where: { issueId },
    orderBy: { createdAt: "asc" },
    include: { user: { select: userSelect } },
  });

  return NextResponse.json({
    watchers: rows.map((r) => r.user),
    isWatching: rows.some((r) => r.userId === userId),
  });
}

export async function POST(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { issueId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return NextResponse.json({ error: "Issue not found" }, { status: 404 });
  }

  await prisma.issueWatcher.createMany({ data: [{ issueId, userId }], skipDuplicates: true });

  return NextResponse.json({ isWatching: true });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { issueId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return NextResponse.json({ error: "Issue not found" }, { status: 404 });
  }

  await prisma.issueWatcher.deleteMany({ where: { issueId, userId } });

  return NextResponse.json({ isWatching: false });
}
