import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, apiError } from "@/lib/api";
import { updateSopStepSchema } from "@/lib/validation";
import { getAccessibleSop } from "@/lib/sops";
import { reorder } from "@/lib/issues";

type Params = { params: Promise<{ id: string; stepId: string }> };

/**
 * @swagger
 * /sops/{id}/steps/{stepId}:
 *   patch:
 *     tags: [SOPs]
 *     summary: Update a step
 *     description: Edit fields or move it (position = 0-based index). Bumps the SOP's version. Runbooks already attached to issues are not affected.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: path, name: stepId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title: { type: string }
 *               description: { type: string }
 *               command: { type: string, nullable: true }
 *               requiresSignoff: { type: boolean }
 *               position: { type: integer, minimum: 0 }
 *     responses:
 *       200:
 *         description: The updated step.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 step: { $ref: '#/components/schemas/SopStep' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [SOPs]
 *     summary: Delete a step
 *     description: Bumps the SOP's version.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: path, name: stepId, required: true, schema: { type: string } }
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
  const { id, stepId } = await params;

  if (!(await getAccessibleSop(userId, id))) {
    return apiError(404, "SOP not found");
  }
  if (!(await prisma.sopStep.findFirst({ where: { id: stepId, sopId: id } }))) {
    return apiError(404, "Step not found");
  }

  const parsed = await parseJsonBody(req, updateSopStepSchema);
  if (!parsed.success) return parsed.response;
  const { position, config, condition, ...stepFields } = parsed.data;
  const fields = {
    ...stepFields,
    ...(config !== undefined && { config: config as Prisma.InputJsonValue }),
    ...(condition !== undefined && { condition: condition === null ? Prisma.DbNull : condition as Prisma.InputJsonValue }),
  };

  const step = await prisma.$transaction(async (tx) => {
    if (position !== undefined) {
      const siblings = await tx.sopStep.findMany({
        where: { sopId: id },
        orderBy: { position: "asc" },
        select: { id: true },
      });
      const order = reorder(siblings.map((s) => s.id), stepId, position);
      for (const [index, siblingId] of order.entries()) {
        await tx.sopStep.update({ where: { id: siblingId }, data: { position: index } });
      }
    }
    await tx.sop.update({ where: { id }, data: { version: { increment: 1 } } });
    return tx.sopStep.update({ where: { id: stepId }, data: fields });
  });

  return NextResponse.json({ step });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { id, stepId } = await params;

  if (!(await getAccessibleSop(userId, id))) {
    return apiError(404, "SOP not found");
  }
  if (!(await prisma.sopStep.findFirst({ where: { id: stepId, sopId: id } }))) {
    return apiError(404, "Step not found");
  }

  await prisma.$transaction(async (tx) => {
    await tx.sopStep.delete({ where: { id: stepId } });
    const remaining = await tx.sopStep.findMany({
      where: { sopId: id },
      orderBy: { position: "asc" },
      select: { id: true },
    });
    for (const [index, sibling] of remaining.entries()) {
      await tx.sopStep.update({ where: { id: sibling.id }, data: { position: index } });
    }
    await tx.sop.update({ where: { id }, data: { version: { increment: 1 } } });
  });

  return NextResponse.json({ message: "Step deleted" });
}
