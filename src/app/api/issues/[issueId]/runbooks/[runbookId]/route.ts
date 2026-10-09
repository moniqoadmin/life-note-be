import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, apiError } from "@/lib/api";
import { runEngine } from "@/lib/api";
import { updateRunbookSchema } from "@/lib/validation";
import { getAccessibleIssue, getRunbook, withRunbookProgress } from "@/lib/issues";
import { ENGINE_TX_OPTIONS, updateExecution } from "@/lib/sop-engine";

type Params = { params: Promise<{ issueId: string; runbookId: string }> };

/**
 * @swagger
 * /issues/{issueId}/runbooks/{runbookId}:
 *   get:
 *     tags: [Runbooks]
 *     summary: Get a runbook
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/IssueId'
 *       - { in: path, name: runbookId, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: The runbook with steps and progress.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 runbook: { $ref: '#/components/schemas/Runbook' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   patch:
 *     tags: [Runbooks]
 *     summary: Control an execution
 *     description: >-
 *       Any of: switch mode (MANUAL/AUTOMATED); cancel with status SKIPPED (pending steps are skipped,
 *       history kept); or goToStep a step key — backwards re-runs that step and everything after it
 *       on a new attempt, forwards skips the steps in between.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/IssueId'
 *       - { in: path, name: runbookId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               mode: { type: string, enum: [MANUAL, AUTOMATED] }
 *               status: { type: string, enum: [SKIPPED], description: Cancel the execution. }
 *               goToStep: { type: string, description: Step key to jump to. }
 *     responses:
 *       200:
 *         description: The updated runbook.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 runbook: { $ref: '#/components/schemas/Runbook' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Runbooks]
 *     summary: Detach a runbook
 *     description: Deletes the runbook and its step progress. The SOP itself is untouched; the issue history keeps its entries.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/IssueId'
 *       - { in: path, name: runbookId, required: true, schema: { type: string } }
 *     responses:
 *       200: { $ref: '#/components/responses/Deleted' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { issueId, runbookId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return apiError(404, "Issue not found");
  }
  const runbook = await getRunbook(issueId, runbookId);
  if (!runbook) {
    return apiError(404, "Runbook not found");
  }

  return NextResponse.json({ runbook: withRunbookProgress(runbook) });
}

export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { issueId, runbookId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return apiError(404, "Issue not found");
  }
  if (!(await getRunbook(issueId, runbookId))) {
    return apiError(404, "Runbook not found");
  }

  const parsed = await parseJsonBody(req, updateRunbookSchema);
  if (!parsed.success) return parsed.response;

  const failed = await runEngine(() =>
    prisma.$transaction((tx) => updateExecution(tx, { runbookId, userId, ...parsed.data }), ENGINE_TX_OPTIONS)
  );
  if (failed) return failed;

  const runbook = await getRunbook(issueId, runbookId);
  return NextResponse.json({ runbook: runbook && withRunbookProgress(runbook) });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { issueId, runbookId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return apiError(404, "Issue not found");
  }
  const { count } = await prisma.issueRunbook.deleteMany({ where: { id: runbookId, issueId } });
  if (count === 0) {
    return apiError(404, "Runbook not found");
  }

  return NextResponse.json({ message: "Runbook detached" });
}
