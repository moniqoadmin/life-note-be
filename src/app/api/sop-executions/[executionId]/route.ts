import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError, parseJsonBody } from "@/lib/api";
import { updateRunbookSchema } from "@/lib/validation";
import { engineTransaction, updateExecution } from "@/lib/sop/engine";
import { engineErrorResponse, getAccessibleExecution, getExecution } from "@/lib/sop/executions";

type Params = { params: Promise<{ executionId: string }> };

/**
 * @swagger
 * /sop-executions/{executionId}:
 *   get:
 *     tags: [SOP Executions]
 *     summary: Get an SOP execution
 *     description: >-
 *       One run of an SOP against an issue, note or task — steps (with approvals and
 *       who completed them), the full event history, progress, where the SOP came from
 *       (`assignment`) and whether a newer published SOP version exists.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ in: path, name: executionId, required: true, schema: { type: string } }]
 *     responses:
 *       200:
 *         description: The execution.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 execution: { $ref: '#/components/schemas/Runbook' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   patch:
 *     tags: [SOP Executions]
 *     summary: Change mode, cancel or restart an execution
 *     description: >-
 *       `action: CANCEL` stops the run (kept for history, status SKIPPED); `action: RESTART`
 *       rewinds to the first step, resetting every step.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ in: path, name: executionId, required: true, schema: { type: string } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               mode: { type: string, enum: [MANUAL, AUTOMATED] }
 *               action: { type: string, enum: [CANCEL, RESTART] }
 *     responses:
 *       200: { description: The updated execution. }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { description: The execution already finished. }
 *   delete:
 *     tags: [SOP Executions]
 *     summary: Delete an execution and its history
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ in: path, name: executionId, required: true, schema: { type: string } }]
 *     responses:
 *       200: { $ref: '#/components/responses/Deleted' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const { executionId } = await params;
  if (!(await getAccessibleExecution(session.user.id, executionId))) return apiError(404, "Execution not found");
  return NextResponse.json({ execution: await getExecution(executionId) });
}

export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const userId = session.user.id;
  const { executionId } = await params;
  if (!(await getAccessibleExecution(userId, executionId))) return apiError(404, "Execution not found");

  const parsed = await parseJsonBody(req, updateRunbookSchema);
  if (!parsed.success) return parsed.response;
  try {
    await engineTransaction((tx) => updateExecution(tx, executionId, userId, parsed.data));
  } catch (error) {
    return engineErrorResponse(error);
  }
  return NextResponse.json({ execution: await getExecution(executionId) });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const { executionId } = await params;
  if (!(await getAccessibleExecution(session.user.id, executionId))) return apiError(404, "Execution not found");
  await prisma.issueRunbook.delete({ where: { id: executionId } });
  return NextResponse.json({ message: "Execution deleted" });
}
