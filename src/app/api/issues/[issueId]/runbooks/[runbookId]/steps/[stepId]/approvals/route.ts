import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { apiError, parseJsonBody } from "@/lib/api";
import { createRunbookApprovalSchema } from "@/lib/validation";
import { getAccessibleIssue, getRunbook, withRunbookProgress } from "@/lib/issues";
import { engineTransaction, submitApproval } from "@/lib/sop/engine";
import { engineErrorResponse } from "@/lib/sop/executions";

type Params = { params: Promise<{ issueId: string; runbookId: string; stepId: string }> };

/**
 * @swagger
 * /issues/{issueId}/runbooks/{runbookId}/steps/{stepId}/approvals:
 *   post:
 *     tags: [Runbooks]
 *     summary: Approve or reject an approval step
 *     description: Same contract as POST /sop-executions/{executionId}/steps/{stepId}/approvals.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/IssueId'
 *       - { in: path, name: runbookId, required: true, schema: { type: string } }
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
 *       200: { description: The whole runbook after the decision. }
 *       403: { description: Not an eligible approver. }
 *       409: { description: Step not active, or you already decided. }
 */
export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const userId = session.user.id;
  const { issueId, runbookId, stepId } = await params;
  if (!(await getAccessibleIssue(userId, issueId))) return apiError(404, "Issue not found");
  if (!(await getRunbook(issueId, runbookId))) return apiError(404, "Runbook not found");
  const parsed = await parseJsonBody(req, createRunbookApprovalSchema);
  if (!parsed.success) return parsed.response;

  try {
    await engineTransaction((tx) => submitApproval(tx, runbookId, stepId, userId, parsed.data));
  } catch (error) {
    return engineErrorResponse(error);
  }

  const updated = await getRunbook(issueId, runbookId);
  return NextResponse.json({ runbook: updated && withRunbookProgress(updated) });
}
