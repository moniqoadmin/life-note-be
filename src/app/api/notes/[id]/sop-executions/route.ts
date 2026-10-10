import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError, parseJsonBody } from "@/lib/api";
import { attachRunbookSchema } from "@/lib/validation";
import { getOwnedNote } from "@/lib/notes";
import { attachExecution, engineTransaction, resolveSubjectSop } from "@/lib/sop/engine";
import { engineErrorResponse, getExecution, listSubjectExecutions } from "@/lib/sop/executions";

type Params = { params: Promise<{ id: string }> };

/**
 * @swagger
 * /notes/{id}/sop-executions:
 *   get:
 *     tags: [SOP Executions]
 *     summary: A note's SOP executions and SOP resolution
 *     description: >-
 *       `executions` — every SOP run on this note (oldest first, cancelled ones included).
 *       `resolution` — the SOP the note resolves to right now and where it comes from
 *       (`source.kind` OVERRIDE, or ASSIGNMENT with the ancestor that provides it), or null.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: "{ executions, resolution }" }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   post:
 *     tags: [SOP Executions]
 *     summary: Run an SOP on a note manually
 *     description: >-
 *       Starts an extra execution (assignmentType MANUAL) next to any inherited one. To change the
 *       note's own SOP instead, PATCH /notes/{id} with `sopOverrideId`.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
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
 *       201: { description: "{ execution }" }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const { id } = await params;
  if (!(await getOwnedNote(session.user.id, id))) return apiError(404, "Note not found");

  const subject = { type: "NOTE", id } as const;
  const [executions, resolution] = await Promise.all([
    listSubjectExecutions(subject),
    resolveSubjectSop(prisma, subject),
  ]);
  const sop = resolution
    ? await prisma.sop.findUnique({ where: { id: resolution.sopId }, select: { id: true, title: true } })
    : null;
  return NextResponse.json({ executions, resolution: resolution && { ...resolution, sop } });
}

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const userId = session.user.id;
  const { id } = await params;
  if (!(await getOwnedNote(userId, id))) return apiError(404, "Note not found");

  const parsed = await parseJsonBody(req, attachRunbookSchema);
  if (!parsed.success) return parsed.response;
  try {
    const executionId = await engineTransaction((tx) =>
      attachExecution(tx, { type: "NOTE", id }, parsed.data.sopId, userId, parsed.data.mode)
    );
    return NextResponse.json({ execution: await getExecution(executionId) }, { status: 201 });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
