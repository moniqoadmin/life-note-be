import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, apiError } from "@/lib/api";
import { updateWorkLogSchema } from "@/lib/validation";
import { userSelect } from "@/lib/workspaces";
import { getAccessibleIssue } from "@/lib/issues";

type Params = { params: Promise<{ issueId: string; worklogId: string }> };

/**
 * @swagger
 * /issues/{issueId}/worklogs/{worklogId}:
 *   patch:
 *     tags: [Issue details]
 *     summary: Edit a work log
 *     description: Only the user who logged it.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/IssueId'
 *       - { in: path, name: worklogId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               minutes: { type: integer, minimum: 1 }
 *               note: { type: string }
 *               startedAt: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: The updated work log.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 workLog: { $ref: '#/components/schemas/WorkLog' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Issue details]
 *     summary: Delete a work log
 *     description: Only the user who logged it.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/IssueId'
 *       - { in: path, name: worklogId, required: true, schema: { type: string } }
 *     responses:
 *       200: { $ref: '#/components/responses/Deleted' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { issueId, worklogId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return apiError(404, "Issue not found");
  }
  const existing = await prisma.workLog.findFirst({ where: { id: worklogId, issueId } });
  if (!existing) {
    return apiError(404, "Work log not found");
  }
  if (existing.userId !== userId) {
    return apiError(403, "You can only edit your own work logs");
  }

  const parsed = await parseJsonBody(req, updateWorkLogSchema);
  if (!parsed.success) return parsed.response;

  const workLog = await prisma.workLog.update({
    where: { id: worklogId },
    data: parsed.data,
    include: { user: { select: userSelect } },
  });

  return NextResponse.json({ workLog });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { issueId, worklogId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return apiError(404, "Issue not found");
  }
  const existing = await prisma.workLog.findFirst({ where: { id: worklogId, issueId } });
  if (!existing) {
    return apiError(404, "Work log not found");
  }
  if (existing.userId !== userId) {
    return apiError(403, "You can only delete your own work logs");
  }

  await prisma.workLog.delete({ where: { id: worklogId } });

  return NextResponse.json({ message: "Work log deleted" });
}
