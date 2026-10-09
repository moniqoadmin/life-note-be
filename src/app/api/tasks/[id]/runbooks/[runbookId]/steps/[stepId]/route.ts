import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError, parseJsonBody, runEngine } from "@/lib/api";
import { updateRunbookStepSchema } from "@/lib/validation";
import { getOwnedTask } from "@/lib/tasks";
import { getTaskRunbook, withRunbookProgress } from "@/lib/issues";
import { ENGINE_TX_OPTIONS, updateStep } from "@/lib/sop-engine";

type Params = { params: Promise<{ id: string; runbookId: string; stepId: string }> };

/**
 * @swagger
 * /tasks/{id}/runbooks/{runbookId}/steps/{stepId}:
 *   patch:
 *     tags: [Runbooks]
 *     summary: Act on an execution step
 *     description: >-
 *       Acts on one step of an execution. Steps start automatically when the engine reaches them (after
 *       evaluating their condition), so status changes are: VERIFIED (complete the active step), FAILED /
 *       BLOCKED (the active step), SKIPPED, IN_PROGRESS (retry a FAILED/BLOCKED step on a new attempt), or
 *       PENDING (rewind to this step — it and every later step re-run). Type rules: APPROVAL steps complete
 *       via the approvals endpoint; CONDITION/AUTOMATED_ACTION run themselves; CHECKLIST needs every
 *       required item in checkedItems; TESTING takes result PASSED (completes) or FAILED (fails);
 *       requiresSignoff needs notes. config.allowedUserIds/allowedRoles restrict who may act. Only
 *       owners/admins may skip an approval. Completing/failing a step fires the SOP's rules, then the
 *       engine moves to the next applicable step.
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
 *             properties:
 *               status: { type: string, enum: [PENDING, IN_PROGRESS, VERIFIED, FAILED, BLOCKED, SKIPPED] }
 *               notes: { type: string, description: Sign-off notes / links. }
 *               output: { type: string, description: "Command output, e.g. \"3,412 tokens purged\"." }
 *               executor: { type: string, nullable: true, description: "Non-human executor, e.g. \"automated pipeline #4418\"." }
 *               result: { type: string, description: "TESTING: PASSED or FAILED. Others: free-form outcome." }
 *               checkedItems: { type: array, items: { type: string }, description: "CHECKLIST: ticked item ids (replaces the set)." }
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
export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const userId = session.user.id;
  const { id, runbookId, stepId } = await params;
  if (!(await getOwnedTask(userId, id))) return apiError(404, "Task not found");
  if (!(await getTaskRunbook(id, runbookId))) return apiError(404, "Execution not found");
  const parsed = await parseJsonBody(req, updateRunbookStepSchema);
  if (!parsed.success) return parsed.response;

  const failed = await runEngine(() =>
    prisma.$transaction((tx) => updateStep(tx, { runbookId, stepId, userId, input: parsed.data }), ENGINE_TX_OPTIONS)
  );
  if (failed) return failed;

  const updated = await getTaskRunbook(id, runbookId);
  return NextResponse.json({ runbook: updated && withRunbookProgress(updated) });
}
