import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { apiError, parseJsonBody } from "@/lib/api";
import { updateRunbookStepSchema } from "@/lib/validation";
import { engineTransaction, updateStep } from "@/lib/sop/engine";
import { engineErrorResponse, getAccessibleExecution, getExecution } from "@/lib/sop/executions";

type Params = { params: Promise<{ executionId: string; stepId: string }> };

/**
 * @swagger
 * /sop-executions/{executionId}/steps/{stepId}:
 *   patch:
 *     tags: [SOP Executions]
 *     summary: Work a step
 *     description: >-
 *       Only the active step can be finished. `status`: VERIFIED completes it (checklists need
 *       every required item ticked, sign-off steps need notes, testing steps need a `result`),
 *       FAILED / BLOCKED / SKIPPED do what they say (mandatory steps can't be skipped).
 *       IN_PROGRESS retries a failed/blocked active step, or — on an earlier finished step —
 *       rewinds the run to it. `result` (TESTING): PASSED completes, FAILED fails the step.
 *       `checklist` ticks CHECKLIST items. Approval steps finish via the approvals endpoint;
 *       condition steps run automatically. Completing a step evaluates the next steps'
 *       conditions and fires the SOP's rules.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: executionId, required: true, schema: { type: string } }
 *       - { in: path, name: stepId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status: { type: string, enum: [PENDING, IN_PROGRESS, VERIFIED, FAILED, BLOCKED, SKIPPED] }
 *               result: { type: string, enum: [PASSED, FAILED] }
 *               checklist: { type: object, additionalProperties: { type: boolean } }
 *               notes: { type: string }
 *               output: { type: string }
 *               executor: { type: string, nullable: true }
 *     responses:
 *       200: { description: The whole execution after the change. }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { description: Not the active step, or the execution was cancelled. }
 */
export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const userId = session.user.id;
  const { executionId, stepId } = await params;
  if (!(await getAccessibleExecution(userId, executionId))) return apiError(404, "Execution not found");

  const parsed = await parseJsonBody(req, updateRunbookStepSchema);
  if (!parsed.success) return parsed.response;
  try {
    await engineTransaction((tx) => updateStep(tx, executionId, stepId, userId, parsed.data));
  } catch (error) {
    return engineErrorResponse(error);
  }
  return NextResponse.json({ execution: await getExecution(executionId) });
}
