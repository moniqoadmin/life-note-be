import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError, parseJsonBody } from "@/lib/api";
import { createSopRuleSchema } from "@/lib/validation";
import { findMissingStepKey, getAccessibleSop, referencedStepKeys } from "@/lib/sops";

type Params = { params: Promise<{ id: string }> };

/**
 * @swagger
 * /sops/{id}/rules:
 *   get:
 *     tags: [SOPs]
 *     summary: List an SOP's rules
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: The rules, oldest first (the order they run in).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 rules: { type: array, items: { $ref: '#/components/schemas/SopRule' } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   post:
 *     tags: [SOPs]
 *     summary: Add a rule
 *     description: >-
 *       When `trigger` fires on an execution of this SOP and `condition` holds, `actions` run in order.
 *       Example — send failed QA back to development:
 *       { "name": "QA failed → back to dev", "trigger": "STEP_FAILED",
 *         "condition": { "field": "event.step.key", "operator": "EQUALS", "value": "qa-testing" },
 *         "actions": [{ "type": "GO_TO_STEP", "stepKey": "development-complete" },
 *                     { "type": "SET_ISSUE_STATUS", "status": "IN_PROGRESS" }] }.
 *       Rules are snapshotted into executions when they start. Bumps the SOP's version.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/SopRuleInput' }
 *     responses:
 *       201:
 *         description: The created rule.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 rule: { $ref: '#/components/schemas/SopRule' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const { id } = await params;
  if (!(await getAccessibleSop(session.user.id, id))) return apiError(404, "SOP not found");
  const rules = await prisma.sopRule.findMany({ where: { sopId: id }, orderBy: { createdAt: "asc" } });
  return NextResponse.json({ rules });
}

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const { id } = await params;
  if (!(await getAccessibleSop(session.user.id, id))) return apiError(404, "SOP not found");
  const parsed = await parseJsonBody(req, createSopRuleSchema);
  if (!parsed.success) return parsed.response;
  const data = parsed.data;
  const missing = await findMissingStepKey(id, referencedStepKeys(data.actions));
  if (missing) return apiError(400, missing);
  const rule = await prisma.$transaction(async (tx) => {
    const created = await tx.sopRule.create({ data: {
      sopId: id, name: data.name, trigger: data.trigger, enabled: data.enabled,
      condition: data.condition as Prisma.InputJsonValue,
      actions: data.actions as Prisma.InputJsonArray,
    } });
    await tx.sop.update({ where: { id }, data: { version: { increment: 1 } } });
    return created;
  });
  return NextResponse.json({ rule }, { status: 201 });
}
