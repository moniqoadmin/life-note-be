import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, apiError } from "@/lib/api";
import { updateRunbookStepSchema } from "@/lib/validation";
import { getAccessibleIssue, getRunbook, recordActivity, withRunbookProgress } from "@/lib/issues";
import { advanceRunbook, applySopRules, recordRunbookEvent } from "@/lib/sop-engine";

type Params = { params: Promise<{ issueId: string; runbookId: string; stepId: string }> };

const isFinished = (status: string) => status === "VERIFIED" || status === "SKIPPED";

/**
 * @swagger
 * /issues/{issueId}/runbooks/{runbookId}/steps/{stepId}:
 *   patch:
 *     tags: [Runbooks]
 *     summary: Update a runbook step
 *     description: >-
 *       Start ("Execute Step" → IN_PROGRESS), complete (VERIFIED), skip (SKIPPED) or reset (PENDING) a
 *       step, and record notes/output. Steps run in order: a step can only start or finish once every
 *       earlier step is VERIFIED or SKIPPED, and can only be reset while every later step is still
 *       PENDING. Steps with requiresSignoff need non-empty notes to be VERIFIED. Finishing a step
 *       records the caller as completedBy; every status change is written to the issue history.
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
 *               status: { type: string, enum: [PENDING, IN_PROGRESS, VERIFIED, SKIPPED] }
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
 *         description: Out of order — an earlier step isn't finished, or a later step has already started.
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
  const { status, notes, output, executor } = parsed.data;

  const statusChanged = status !== undefined && status !== step.status;
  if (statusChanged) {
    if (status === "VERIFIED" && step.type === "APPROVAL") {
      return apiError(400, "Approval steps must be completed through the approvals endpoint");
    }
    const earlier = runbook.steps.filter((s) => s.position < step.position);
    const later = runbook.steps.filter((s) => s.position > step.position);

    if (status !== "PENDING") {
      const blocker = earlier.find((s) => !isFinished(s.status));
      if (blocker) {
        return apiError(409, `Finish step ${blocker.position + 1} ("${blocker.title}") first`);
      }
    }
    if (!isFinished(status)) {
      const started = later.find((s) => s.status !== "PENDING");
      if (started) {
        return apiError(409, `Step ${started.position + 1} has already started; reset it first`);
      }
    }
    if (status === "VERIFIED" && step.requiresSignoff && !(notes ?? step.notes).trim()) {
      return apiError(400, "This step requires sign-off notes before it can be verified");
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.runbookStep.update({
      where: { id: stepId },
      data: {
        ...(notes !== undefined && { notes }),
        ...(output !== undefined && { output }),
        ...(executor !== undefined && { executor }),
        ...(statusChanged && {
          status,
          completedById: status === "PENDING" || status === "IN_PROGRESS" ? null : userId,
          completedAt: status === "PENDING" || status === "IN_PROGRESS" ? null : new Date(),
        }),
      },
    });
    if (statusChanged) {
      if (status === "FAILED" || status === "BLOCKED") {
        await tx.issueRunbook.update({ where: { id: runbookId }, data: { status, currentStepId: stepId } });
        await recordRunbookEvent(tx, runbookId, userId, `STEP_${status}`, { stepId, title: step.title, output });
        if (status === "FAILED") await applySopRules(tx, runbookId, issueId, "STEP_FAILED", userId);
      } else if (status === "IN_PROGRESS") {
        await tx.issueRunbook.update({ where: { id: runbookId }, data: { status: "IN_PROGRESS", currentStepId: stepId } });
        await recordRunbookEvent(tx, runbookId, userId, "STEP_STARTED", { stepId, title: step.title });
      } else if (status === "VERIFIED" || status === "SKIPPED") {
        await recordRunbookEvent(tx, runbookId, userId, status === "VERIFIED" ? "STEP_COMPLETED" : "STEP_SKIPPED", { stepId, title: step.title, notes, output });
        await advanceRunbook(tx, runbookId, issueId, stepId, userId);
        await applySopRules(tx, runbookId, issueId, status === "VERIFIED" ? "STEP_COMPLETED" : "STEP_SKIPPED", userId);
      }
      await recordActivity(tx, issueId, userId, "RUNBOOK_STEP_UPDATED", {
        runbookId,
        stepId,
        step: step.position + 1,
        title: step.title,
        from: step.status,
        to: status,
        ...(executor && { executor }),
      });
    }
  });

  const updated = await getRunbook(issueId, runbookId);
  return NextResponse.json({ runbook: updated && withRunbookProgress(updated) });
}
