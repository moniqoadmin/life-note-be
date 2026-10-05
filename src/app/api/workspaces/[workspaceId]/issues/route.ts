import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { listIssuesQuerySchema } from "@/lib/validation";
import { getMembership } from "@/lib/workspaces";
import { buildIssueWhere, issueListInclude, issueOrderBy, queryToObject } from "@/lib/issues";
import { validationError, apiError } from "@/lib/api";

type Params = { params: Promise<{ workspaceId: string }> };

/**
 * @swagger
 * /workspaces/{workspaceId}/issues:
 *   get:
 *     tags: [Issues]
 *     summary: List issues across a workspace
 *     description: Same filters as the per-project list, across every project — e.g. a sprint board spanning projects, or "my issues" (assigneeId=me).
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/WorkspaceId'
 *       - { in: query, name: projectId, schema: { type: string } }
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
 */
export async function GET(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { workspaceId } = await params;

  if (!(await getMembership(userId, workspaceId))) {
    return apiError(404, "Workspace not found");
  }

  const query = listIssuesQuerySchema.safeParse(queryToObject(new URL(req.url).searchParams));
  if (!query.success) {
    return validationError(query.error);
  }

  const where = { ...buildIssueWhere(userId, query.data), workspaceId };
  const [issues, total] = await Promise.all([
    prisma.issue.findMany({
      where,
      orderBy: issueOrderBy(query.data.sort),
      include: { ...issueListInclude, project: { select: { id: true, key: true, name: true } } },
      take: query.data.limit,
      skip: query.data.offset,
    }),
    prisma.issue.count({ where }),
  ]);

  return NextResponse.json({ issues, total });
}
