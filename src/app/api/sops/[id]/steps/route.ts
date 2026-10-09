import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, apiError } from "@/lib/api";
import { createSopStepSchema } from "@/lib/validation";
import { getAccessibleSop, parseStepConfig, slugifyStepKey, uniqueStepKey } from "@/lib/sops";
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
 *               key: { type: string, example: qa-testing, description: "Stable handle used by conditions and rules (steps.<key>.result, GO_TO_STEP). Defaults to a slug of the title; must be unique in the SOP." }
 *               title: { type: string, example: Identify & Revoke Affected Refresh Tokens }
 *               description: { type: string }
 *               command: { type: string, nullable: true, example: "pnpm run auth:revoke --token-id=all-compromised" }
 *               requiresSignoff: { type: boolean, default: false, description: Require sign-off notes before the step can be verified in a runbook. }
 *               type: { $ref: '#/components/schemas/SopStepType' }
 *               config: { type: object, description: "Type-specific settings; see the SopStep schema." }
 *               condition: { $ref: '#/components/schemas/SopCondition' }
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
  const { position, command, config, condition, key, ...fields } = parsed.data;

  const stepConfig = parseStepConfig(fields.type, config);
  if (!stepConfig.success) return apiError(400, stepConfig.error);
  if (key && (await prisma.sopStep.findUnique({ where: { sopId_key: { sopId: id, key } } }))) {
    return apiError(409, `A step with key "${key}" already exists in this SOP`);
  }

  const step = await prisma.$transaction(async (tx) => {
    const siblings = await tx.sopStep.findMany({
      where: { sopId: id },
      orderBy: { position: "asc" },
      select: { id: true },
    });
    const created = await tx.sopStep.create({
      data: {
        sopId: id,
        ...fields,
        key: key ?? (await uniqueStepKey(tx, id, slugifyStepKey(fields.title))),
        command: command ?? null,
        position: siblings.length,
        config: stepConfig.config,
        ...(condition != null && { condition: condition as Prisma.InputJsonValue }),
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
