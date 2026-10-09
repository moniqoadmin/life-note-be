import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError, parseJsonBody, runEngine } from "@/lib/api";
import { updateRunbookSchema } from "@/lib/validation";
import { getOwnedNote } from "@/lib/notes";
import { getNoteRunbook, withRunbookProgress } from "@/lib/issues";
import { ENGINE_TX_OPTIONS, updateExecution } from "@/lib/sop-engine";

type Params = { params: Promise<{ id: string; runbookId: string }> };

/**
 * @swagger
 * /notes/{id}/runbooks/{runbookId}:
 *   get:
 *     tags: [Runbooks]
 *     summary: Get a note's SOP execution
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: path, name: runbookId, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: The execution with steps, approvals, history and progress.
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
 *     summary: Control a note's execution
 *     description: Same as PATCH /issues/{issueId}/runbooks/{runbookId} — mode, cancel (status SKIPPED) or goToStep.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: path, name: runbookId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               mode: { type: string, enum: [MANUAL, AUTOMATED] }
 *               status: { type: string, enum: [SKIPPED] }
 *               goToStep: { type: string }
 *     responses:
 *       200:
 *         description: The updated execution.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 runbook: { $ref: '#/components/schemas/Runbook' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const { id, runbookId } = await params;
  if (!(await getOwnedNote(session.user.id, id))) return apiError(404, "Note not found");
  const runbook = await getNoteRunbook(id, runbookId);
  if (!runbook) return apiError(404, "Execution not found");
  return NextResponse.json({ runbook: withRunbookProgress(runbook) });
}

export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const userId = session.user.id;
  const { id, runbookId } = await params;
  if (!(await getOwnedNote(userId, id))) return apiError(404, "Note not found");
  if (!(await getNoteRunbook(id, runbookId))) return apiError(404, "Execution not found");
  const parsed = await parseJsonBody(req, updateRunbookSchema);
  if (!parsed.success) return parsed.response;

  const failed = await runEngine(() =>
    prisma.$transaction((tx) => updateExecution(tx, { runbookId, userId, ...parsed.data }), ENGINE_TX_OPTIONS)
  );
  if (failed) return failed;

  const runbook = await getNoteRunbook(id, runbookId);
  return NextResponse.json({ runbook: runbook && withRunbookProgress(runbook) });
}
