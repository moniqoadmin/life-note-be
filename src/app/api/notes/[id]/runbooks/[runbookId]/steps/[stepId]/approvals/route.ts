import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError, parseJsonBody, runEngine } from "@/lib/api";
import { createRunbookApprovalSchema } from "@/lib/validation";
import { getOwnedNote } from "@/lib/notes";
import { getNoteRunbook, withRunbookProgress } from "@/lib/issues";
import { ENGINE_TX_OPTIONS, submitApproval } from "@/lib/sop-engine";

type Params = { params: Promise<{ id: string; runbookId: string; stepId: string }> };

/**
 * @swagger
 * /notes/{id}/runbooks/{runbookId}/steps/{stepId}/approvals:
 *   post:
 *     tags: [Runbooks]
 *     summary: Approve or reject an approval step
 *     description: >-
 *       One decision per user per step attempt. REJECTED fails the step (firing STEP_FAILED rules).
 *       The step completes once APPROVED decisions on the current attempt reach config.requiredApprovals
 *       (default 1; rules can raise it, e.g. REQUIRE_APPROVALS for high-risk issues). If
 *       config.approvers is set, only matching users (userIds / workspace roles / projectLead) may decide.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
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
 *       200:
 *         description: The whole execution, with updated progress.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 runbook: { $ref: '#/components/schemas/Runbook' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409:
 *         description: The step isn't in a state that allows this change (e.g. not the active step).
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const userId = session.user.id;
  const { id, runbookId, stepId } = await params;
  if (!(await getOwnedNote(userId, id))) return apiError(404, "Note not found");
  if (!(await getNoteRunbook(id, runbookId))) return apiError(404, "Execution not found");
  const parsed = await parseJsonBody(req, createRunbookApprovalSchema);
  if (!parsed.success) return parsed.response;

  const failed = await runEngine(() =>
    prisma.$transaction((tx) => submitApproval(tx, { runbookId, stepId, userId, ...parsed.data }), ENGINE_TX_OPTIONS)
  );
  if (failed) return failed;

  const updated = await getNoteRunbook(id, runbookId);
  return NextResponse.json({ runbook: updated && withRunbookProgress(updated) });
}
