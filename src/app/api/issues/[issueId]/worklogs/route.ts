import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody } from "@/lib/api";
import { createWorkLogSchema, paginationSchema } from "@/lib/validation";
import { userSelect } from "@/lib/workspaces";
import { getAccessibleIssue, queryToObject, recordActivity } from "@/lib/issues";

type Params = { params: Promise<{ issueId: string }> };

/**
 * @swagger
 * /issues/{issueId}/worklogs:
 *   get:
 *     tags: [Issue details]
 *     summary: List work logs
 *     description: Newest first, with the total logged time across all entries.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/IssueId'
 *       - $ref: '#/components/parameters/Limit'
 *       - $ref: '#/components/parameters/Offset'
 *     responses:
 *       200:
 *         description: The work logs.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 workLogs: { type: array, items: { $ref: '#/components/schemas/WorkLog' } }
 *                 total: { type: integer }
 *                 loggedMinutes: { type: integer }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   post:
 *     tags: [Issue details]
 *     summary: Log work
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/IssueId' }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [minutes]
 *             properties:
 *               minutes: { type: integer, minimum: 1 }
 *               note: { type: string }
 *               startedAt: { type: string, format: date-time, description: Defaults to now. }
 *     responses:
 *       201:
 *         description: The created work log.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 workLog: { $ref: '#/components/schemas/WorkLog' }
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

  const [workLogs, agg] = await Promise.all([
    prisma.workLog.findMany({
      where: { issueId },
      orderBy: { startedAt: "desc" },
      include: { user: { select: userSelect } },
      take: page.data.limit,
      skip: page.data.offset,
    }),
    prisma.workLog.aggregate({ where: { issueId }, _count: true, _sum: { minutes: true } }),
  ]);

  return NextResponse.json({
    workLogs,
    total: agg._count,
    loggedMinutes: agg._sum.minutes ?? 0,
  });
}

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { issueId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return NextResponse.json({ error: "Issue not found" }, { status: 404 });
  }

  const parsed = await parseJsonBody(req, createWorkLogSchema);
  if (!parsed.success) return parsed.response;
  const { minutes, note, startedAt } = parsed.data;

  const workLog = await prisma.$transaction(async (tx) => {
    const created = await tx.workLog.create({
      data: { issueId, userId, minutes, note, startedAt: startedAt ?? new Date() },
      include: { user: { select: userSelect } },
    });
    await recordActivity(tx, issueId, userId, "WORK_LOGGED", { workLogId: created.id, minutes });
    return created;
  });

  return NextResponse.json({ workLog }, { status: 201 });
}
