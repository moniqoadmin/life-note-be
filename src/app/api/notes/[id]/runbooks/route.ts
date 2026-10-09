import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError, parseJsonBody } from "@/lib/api";
import { attachRunbookSchema } from "@/lib/validation";
import { getOwnedNote } from "@/lib/notes";
import { getAccessibleSop } from "@/lib/sops";
import { getNoteRunbook, listRunbooks, withRunbookProgress } from "@/lib/issues";
import { ENGINE_TX_OPTIONS, startExecution } from "@/lib/sop-engine";

type Params = { params: Promise<{ id: string }> };

/**
 * @swagger
 * /notes/{id}/runbooks:
 *   get:
 *     tags: [Runbooks]
 *     summary: List a note's SOP executions
 *     description: Oldest first, each with steps, approvals, history and progress.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: The executions.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 runbooks: { type: array, items: { $ref: '#/components/schemas/Runbook' } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   post:
 *     tags: [Runbooks]
 *     summary: Start an SOP execution on a note manually
 *     description: Same as POST /issues/{issueId}/runbooks (assignmentType MANUAL).
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sopId]
 *             properties:
 *               sopId: { type: string }
 *               mode: { type: string, enum: [MANUAL, AUTOMATED], default: MANUAL }
 *     responses:
 *       201:
 *         description: The execution.
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
  const { id } = await params;
  if (!(await getOwnedNote(session.user.id, id))) return apiError(404, "Note not found");
  return NextResponse.json({ runbooks: await listRunbooks({ noteId: id }) });
}

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const userId = session.user.id;
  const { id } = await params;
  if (!(await getOwnedNote(userId, id))) return apiError(404, "Note not found");

  const parsed = await parseJsonBody(req, attachRunbookSchema);
  if (!parsed.success) return parsed.response;
  const { sopId, mode } = parsed.data;
  if (!(await getAccessibleSop(userId, sopId))) return apiError(404, "SOP not found");
  if ((await prisma.sopStep.count({ where: { sopId } })) === 0) {
    return apiError(400, "This SOP has no steps to run");
  }

  const runbookId = await prisma.$transaction(
    (tx) => startExecution(tx, { target: { noteId: id }, sopId, assignmentType: "MANUAL", actorId: userId, mode }),
    ENGINE_TX_OPTIONS
  );
  const runbook = await getNoteRunbook(id, runbookId);
  return NextResponse.json({ runbook: runbook && withRunbookProgress(runbook) }, { status: 201 });
}
