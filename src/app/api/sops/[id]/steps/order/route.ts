import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError, parseJsonBody } from "@/lib/api";
import { reorderSopStepsSchema } from "@/lib/validation";
import { getAccessibleSop } from "@/lib/sops";

type Params = { params: Promise<{ id: string }> };

/**
 * @swagger
 * /sops/{id}/steps/order:
 *   put:
 *     tags: [SOPs]
 *     summary: Reorder all steps
 *     description: Sets the full step order in one call (e.g. after a drag-and-drop). stepIds must list every step of the SOP exactly once. Bumps the SOP's version.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [stepIds]
 *             properties:
 *               stepIds: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: The steps in their new order.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 steps: { type: array, items: { $ref: '#/components/schemas/SopStep' } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function PUT(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const { id } = await params;

  if (!(await getAccessibleSop(session.user.id, id))) {
    return apiError(404, "SOP not found");
  }

  const parsed = await parseJsonBody(req, reorderSopStepsSchema);
  if (!parsed.success) return parsed.response;
  const { stepIds } = parsed.data;

  const existing = await prisma.sopStep.findMany({ where: { sopId: id }, select: { id: true } });
  const known = new Set(existing.map((s) => s.id));
  if (stepIds.length !== known.size || new Set(stepIds).size !== stepIds.length || stepIds.some((s) => !known.has(s))) {
    return apiError(400, "stepIds must list every step of this SOP exactly once");
  }

  const steps = await prisma.$transaction(async (tx) => {
    for (const [index, stepId] of stepIds.entries()) {
      await tx.sopStep.update({ where: { id: stepId }, data: { position: index } });
    }
    await tx.sop.update({ where: { id }, data: { version: { increment: 1 } } });
    return tx.sopStep.findMany({ where: { sopId: id }, orderBy: { position: "asc" } });
  });

  return NextResponse.json({ steps });
}
