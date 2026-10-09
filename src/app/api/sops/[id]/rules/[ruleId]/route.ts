import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError, parseJsonBody } from "@/lib/api";
import { updateSopRuleSchema } from "@/lib/validation";
import { findMissingStepKey, getAccessibleSop, referencedStepKeys } from "@/lib/sops";

type Params = { params: Promise<{ id: string; ruleId: string }> };

/**
 * @swagger
 * /sops/{id}/rules/{ruleId}:
 *   patch:
 *     tags: [SOPs]
 *     summary: Update a rule
 *     description: Any subset of the rule's fields. Bumps the SOP's version; running executions keep their snapshot.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: path, name: ruleId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/SopRuleInput' }
 *     responses:
 *       200:
 *         description: The updated rule.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 rule: { $ref: '#/components/schemas/SopRule' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [SOPs]
 *     summary: Delete a rule
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: path, name: ruleId, required: true, schema: { type: string } }
 *     responses:
 *       200: { $ref: '#/components/responses/Deleted' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const { id, ruleId } = await params;
  if (!(await getAccessibleSop(session.user.id, id))) return apiError(404, "SOP not found");
  const existing = await prisma.sopRule.findFirst({ where: { id: ruleId, sopId: id } });
  if (!existing) return apiError(404, "Rule not found");
  const parsed = await parseJsonBody(req, updateSopRuleSchema);
  if (!parsed.success) return parsed.response;
  const data = parsed.data;
  if (data.actions) {
    const missing = await findMissingStepKey(id, referencedStepKeys(data.actions));
    if (missing) return apiError(400, missing);
  }
  const rule = await prisma.$transaction(async (tx) => {
    const updated = await tx.sopRule.update({ where: { id: ruleId }, data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.trigger !== undefined && { trigger: data.trigger }),
      ...(data.enabled !== undefined && { enabled: data.enabled }),
      ...(data.condition !== undefined && { condition: data.condition as Prisma.InputJsonValue }),
      ...(data.actions !== undefined && { actions: data.actions as Prisma.InputJsonArray }),
    } });
    await tx.sop.update({ where: { id }, data: { version: { increment: 1 } } });
    return updated;
  });
  return NextResponse.json({ rule });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const { id, ruleId } = await params;
  if (!(await getAccessibleSop(session.user.id, id))) return apiError(404, "SOP not found");
  const { count } = await prisma.sopRule.deleteMany({ where: { id: ruleId, sopId: id } });
  if (!count) return apiError(404, "Rule not found");
  await prisma.sop.update({ where: { id }, data: { version: { increment: 1 } } });
  return NextResponse.json({ message: "Rule deleted" });
}
