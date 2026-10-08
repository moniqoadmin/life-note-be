import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, apiError } from "@/lib/api";
import { createSopStepSchema } from "@/lib/validation";
import { getAccessibleSop } from "@/lib/sops";
import { reorder } from "@/lib/issues";

type Params = { params: Promise<{ id: string }> };

/**
 * @swagger
 * /sops/{id}/steps:
 *   get:
 *     tags: [SOPs]
 *     summary: List an SOP's steps
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The steps, in order.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 steps: { type: array, items: { $ref: '#/components/schemas/SopStep' } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   post:
 *     tags: [SOPs]
 *     summary: Add a step
 *     description: Appended to the end unless position (0-based) is given. Bumps the SOP's version.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title]
 *             properties:
 *               title: { type: string, example: Identify & Revoke Affected Refresh Tokens }
 *               description: { type: string }
 *               command: { type: string, nullable: true, example: "pnpm run auth:revoke --token-id=all-compromised" }
 *               requiresSignoff: { type: boolean, default: false, description: Require sign-off notes before the step can be verified in a runbook. }
 *               position: { type: integer, minimum: 0 }
 *     responses:
 *       201:
 *         description: The created step.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 step: { $ref: '#/components/schemas/SopStep' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { id } = await params;

  if (!(await getAccessibleSop(userId, id))) {
    return apiError(404, "SOP not found");
  }

  const steps = await prisma.sopStep.findMany({ where: { sopId: id }, orderBy: { position: "asc" } });

  return NextResponse.json({ steps });
}

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { id } = await params;

  if (!(await getAccessibleSop(userId, id))) {
    return apiError(404, "SOP not found");
  }

  const parsed = await parseJsonBody(req, createSopStepSchema);
  if (!parsed.success) return parsed.response;
  const { position, command, ...fields } = parsed.data;

  const step = await prisma.$transaction(async (tx) => {
    const siblings = await tx.sopStep.findMany({
      where: { sopId: id },
      orderBy: { position: "asc" },
      select: { id: true },
    });
    const { config, condition, ...stepFields } = fields;
    const created = await tx.sopStep.create({
      data: {
        sopId: id, ...stepFields, command: command ?? null, position: siblings.length,
        config: config as Prisma.InputJsonValue,
        ...(condition !== undefined && { condition: condition as Prisma.InputJsonValue }),
      },
    });
    if (position !== undefined && position < siblings.length) {
      const order = reorder([...siblings.map((s) => s.id), created.id], created.id, position);
      for (const [index, stepId] of order.entries()) {
        await tx.sopStep.update({ where: { id: stepId }, data: { position: index } });
      }
    }
    await tx.sop.update({ where: { id }, data: { version: { increment: 1 } } });
    return tx.sopStep.findUniqueOrThrow({ where: { id: created.id } });
  });

  return NextResponse.json({ step }, { status: 201 });
}
