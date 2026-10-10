import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { parseJsonBody, apiError } from "@/lib/api";
import { updateRunbookStepSchema } from "@/lib/validation";
import { getAccessibleIssue, getRunbook, recordActivity, withRunbookProgress } from "@/lib/issues";
import { engineTransaction, updateStep } from "@/lib/sop/engine";
import { engineErrorResponse } from "@/lib/sop/executions";

type Params = { params: Promise<{ issueId: string; runbookId: string; stepId: string }> };

/**
 * @swagger
 * /issues/{issueId}/runbooks/{runbookId}/steps/{stepId}:
 *   patch:
 *     tags: [Runbooks]
 *     summary: Update a runbook step
 *     description: >-
 *       Same contract as PATCH /sop-executions/{executionId}/steps/{stepId}. Only the active step can
 *       be completed (VERIFIED), failed, blocked or skipped; IN_PROGRESS (or PENDING) on an earlier
 *       finished step rewinds the run to it. Steps with requiresSignoff need non-empty notes; TESTING
 *       steps take `result`, CHECKLIST steps take `checklist`. Finishing a step records the caller as
 *       completedBy and starts the next applicable step; status changes go to the issue history.
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
 *             properties:
 *               status: { type: string, enum: [PENDING, IN_PROGRESS, VERIFIED, FAILED, BLOCKED, SKIPPED] }
 *               result: { type: string, enum: [PASSED, FAILED] }
 *               checklist: { type: object, additionalProperties: { type: boolean } }
 *               notes: { type: string, description: Sign-off notes / links. }
 *               output: { type: string, description: "Command output, e.g. \"3,412 tokens purged\"." }
 *               executor: { type: string, nullable: true, description: "Non-human executor, e.g. \"automated pipeline #4418\"." }
 *     responses:
 *       200:
 *         description: The whole runbook, with updated progress.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 runbook: { $ref: '#/components/schemas/Runbook' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409:
 *         description: Not the active step, or the runbook was cancelled.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { issueId, runbookId, stepId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return apiError(404, "Issue not found");
  }
  const runbook = await getRunbook(issueId, runbookId);
  if (!runbook) {
    return apiError(404, "Runbook not found");
  }
  const step = runbook.steps.find((s) => s.id === stepId);
  if (!step) {
    return apiError(404, "Step not found");
  }

  const parsed = await parseJsonBody(req, updateRunbookStepSchema);
  if (!parsed.success) return parsed.response;

  try {
    await engineTransaction(async (tx) => {
      await updateStep(tx, runbookId, stepId, userId, parsed.data);
      const after = await tx.runbookStep.findUniqueOrThrow({ where: { id: stepId }, select: { status: true } });
      if (after.status !== step.status) {
        await recordActivity(tx, issueId, userId, "RUNBOOK_STEP_UPDATED", {
          runbookId,
          stepId,
          step: step.position + 1,
          title: step.title,
          from: step.status,
          to: after.status,
          ...(parsed.data.executor && { executor: parsed.data.executor }),
        });
      }
    });
  } catch (error) {
    return engineErrorResponse(error);
  }

  const updated = await getRunbook(issueId, runbookId);
  return NextResponse.json({ runbook: updated && withRunbookProgress(updated) });
}
