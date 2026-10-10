import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { apiError, parseJsonBody } from "@/lib/api";
import { createRunbookApprovalSchema } from "@/lib/validation";
import { engineTransaction, submitApproval } from "@/lib/sop/engine";
import { engineErrorResponse, getAccessibleExecution, getExecution } from "@/lib/sop/executions";

type Params = { params: Promise<{ executionId: string; stepId: string }> };

/**
 * @swagger
 * /sop-executions/{executionId}/steps/{stepId}/approvals:
 *   post:
 *     tags: [SOP Executions]
 *     summary: Approve or reject an approval step
 *     description: >-
 *       One decision per person. The step completes once `requiredApprovals` (resolved from the
 *       step config, including conditional overrides) APPROVED decisions are in; a single
 *       REJECTED fails it (and fires STEP_FAILED rules). The step's `approverIds`,
 *       `approverRoles` and `preventSelfApproval` decide who may decide (403 otherwise).
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
 *             required: [decision]
 *             properties:
 *               decision: { type: string, enum: [APPROVED, REJECTED] }
 *               comment: { type: string }
 *     responses:
 *       200: { description: The whole execution after the decision. }
 *       403: { description: Not an eligible approver. }
 *       409: { description: Step not active, or you already decided. }
 */
export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const userId = session.user.id;
  const { executionId, stepId } = await params;
  if (!(await getAccessibleExecution(userId, executionId))) return apiError(404, "Execution not found");

  const parsed = await parseJsonBody(req, createRunbookApprovalSchema);
  if (!parsed.success) return parsed.response;
  try {
    await engineTransaction((tx) => submitApproval(tx, executionId, stepId, userId, parsed.data));
  } catch (error) {
    return engineErrorResponse(error);
  }
  return NextResponse.json({ execution: await getExecution(executionId) });
}
