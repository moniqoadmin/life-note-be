import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { workspaceSearchSchema } from "@/lib/validation";
import { getMembership, userSelect } from "@/lib/workspaces";
import { issueRefSelect, queryToObject } from "@/lib/issues";

type Params = { params: Promise<{ workspaceId: string }> };

/**
 * @swagger
 * /workspaces/{workspaceId}/search:
 *   get:
 *     tags: [Issues]
 *     summary: Search issues and comments
 *     description: Global search box — case-insensitive substring match on issue key, title and description, and on comment bodies.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/WorkspaceId'
 *       - { in: query, name: q, required: true, schema: { type: string } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 50, default: 20 }, description: Max results per group. }
 *     responses:
 *       200:
 *         description: Matches, most recently updated first.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 issues: { type: array, items: { $ref: '#/components/schemas/IssueRef' } }
 *                 comments:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       body: { type: string }
 *                       createdAt: { type: string, format: date-time }
 *                       author: { $ref: '#/components/schemas/User' }
 *                       issue: { $ref: '#/components/schemas/IssueRef' }
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
  const { workspaceId } = await params;

  if (!(await getMembership(userId, workspaceId))) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const parsed = workspaceSearchSchema.safeParse(queryToObject(new URL(req.url).searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid query" },
      { status: 400 }
    );
  }
  const { q, limit } = parsed.data;

  const [issues, comments] = await Promise.all([
    prisma.issue.findMany({
      where: {
        workspaceId,
        OR: [
          { key: { contains: q, mode: "insensitive" } },
          { title: { contains: q, mode: "insensitive" } },
          { description: { contains: q, mode: "insensitive" } },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
      select: issueRefSelect,
    }),
    prisma.issueComment.findMany({
      where: { issue: { workspaceId }, body: { contains: q, mode: "insensitive" } },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        body: true,
        createdAt: true,
        author: { select: userSelect },
        issue: { select: issueRefSelect },
      },
    }),
  ]);

  return NextResponse.json({ issues, comments });
}
