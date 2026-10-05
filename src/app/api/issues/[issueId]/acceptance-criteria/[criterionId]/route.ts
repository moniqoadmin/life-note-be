import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, apiError } from "@/lib/api";
import { updateCriterionSchema } from "@/lib/validation";
import { getAccessibleIssue, reorder } from "@/lib/issues";

type Params = { params: Promise<{ issueId: string; criterionId: string }> };

/**
 * @swagger
 * /issues/{issueId}/acceptance-criteria/{criterionId}:
 *   patch:
 *     tags: [Issue details]
 *     summary: Update an acceptance criterion
 *     description: Tick/untick (done), edit text, or move it (position = 0-based index).
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/IssueId'
 *       - { in: path, name: criterionId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               text: { type: string }
 *               done: { type: boolean }
 *               position: { type: integer, minimum: 0 }
 *     responses:
 *       200:
 *         description: The updated criterion.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 criterion: { $ref: '#/components/schemas/AcceptanceCriterion' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Issue details]
 *     summary: Delete an acceptance criterion
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/IssueId'
 *       - { in: path, name: criterionId, required: true, schema: { type: string } }
 *     responses:
 *       200: { $ref: '#/components/responses/Deleted' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { issueId, criterionId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return apiError(404, "Issue not found");
  }
  const existing = await prisma.acceptanceCriterion.findFirst({
    where: { id: criterionId, issueId },
  });
  if (!existing) {
    return apiError(404, "Criterion not found");
  }

  const parsed = await parseJsonBody(req, updateCriterionSchema);
  if (!parsed.success) return parsed.response;
  const { text, done, position } = parsed.data;

  const criterion = await prisma.$transaction(async (tx) => {
    if (position !== undefined) {
      const siblings = await tx.acceptanceCriterion.findMany({
        where: { issueId },
        orderBy: { position: "asc" },
        select: { id: true },
      });
      const order = reorder(siblings.map((s) => s.id), criterionId, position);
      for (const [index, id] of order.entries()) {
        await tx.acceptanceCriterion.update({ where: { id }, data: { position: index } });
      }
    }
    return tx.acceptanceCriterion.update({
      where: { id: criterionId },
      data: {
        ...(text !== undefined && { text }),
        ...(done !== undefined && { done }),
      },
    });
  });

  return NextResponse.json({ criterion });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { issueId, criterionId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return apiError(404, "Issue not found");
  }
  const { count } = await prisma.acceptanceCriterion.deleteMany({
    where: { id: criterionId, issueId },
  });
  if (count === 0) {
    return apiError(404, "Criterion not found");
  }

  return NextResponse.json({ message: "Criterion deleted" });
}
