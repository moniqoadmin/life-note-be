import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api";
import { getOwnedNote } from "@/lib/notes";
import { OPEN_EXECUTION_STATUSES, resolveNoteSop } from "@/lib/sop-engine";

type Params = { params: Promise<{ id: string }> };

/**
 * @swagger
 * /notes/{id}/sop:
 *   get:
 *     tags: [Runbooks]
 *     summary: Resolve the note's SOP
 *     description: >-
 *       Which SOP applies to this note and why — its own sopOverrideId (TASK_OVERRIDE), else the
 *       nearest ancestor's defaultSopId (ENTITY_INHERITED, source = that ancestor), else none — plus the
 *       note's own defaultSopId and its active automatically assigned execution.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: The resolution.
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const { id } = await params;
  const note = await getOwnedNote(session.user.id, id);
  if (!note) return apiError(404, "Note not found");

  const resolution = await resolveNoteSop(prisma, note);
  const sopSelect = { id: true, title: true, version: true } as const;
  const [sop, source, defaultSop, activeExecution] = await Promise.all([
    resolution ? prisma.sop.findUnique({ where: { id: resolution.sopId }, select: sopSelect }) : null,
    resolution?.source ? prisma.note.findUnique({ where: { id: resolution.source.id }, select: { id: true, title: true } }) : null,
    note.defaultSopId ? prisma.sop.findUnique({ where: { id: note.defaultSopId }, select: sopSelect }) : null,
    prisma.issueRunbook.findFirst({
      where: { noteId: id, assignmentType: { in: ["TASK_OVERRIDE", "ENTITY_INHERITED"] }, status: { in: OPEN_EXECUTION_STATUSES } },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, sopId: true, sopVersion: true, assignmentType: true, currentStepId: true },
    }),
  ]);

  return NextResponse.json({
    assignment: resolution && sop ? { assignmentType: resolution.assignmentType, sop, source } : null,
    defaultSop,
    activeExecution,
  });
}
