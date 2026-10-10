import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { updateNoteSchema } from "@/lib/validation";
import { getOwnedNote, wouldCreateCycle } from "@/lib/notes";
import { apiError, validationError } from "@/lib/api";
import { getAccessibleSop } from "@/lib/sops";
import { ENGINE_TX, notifySubjectChanged, syncAssignedExecution } from "@/lib/sop/engine";

type Params = { params: Promise<{ id: string }> };

/**
 * @swagger
 * /notes/{id}:
 *   get:
 *     tags: [Notes]
 *     summary: Get a note
 *     description: >
 *       Returns a note with its direct children (including each child's status), its
 *       acceptance criteria in display order, and its comments oldest-first.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The note and its direct children.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 note:
 *                   allOf:
 *                     - $ref: '#/components/schemas/Note'
 *                     - type: object
 *                       properties:
 *                         children:
 *                           type: array
 *                           items: { $ref: '#/components/schemas/NoteSummary' }
 *       401:
 *         description: Not authenticated.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       404:
 *         description: Note not found.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *   patch:
 *     tags: [Notes]
 *     summary: Update or move a note
 *     description: >
 *       Updates title/content and issue fields (status, priority, labels),
 *       and/or moves the note by changing parentId (null moves
 *       it to root). Rejects moves that would nest a note under itself or its own
 *       descendant.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title: { type: string }
 *               content: { type: string }
 *               parentId: { type: string, nullable: true }
 *               status: { type: string, enum: [TODO, IN_PROGRESS, IN_REVIEW, DONE] }
 *               priority: { type: string, enum: [URGENT, HIGH, MEDIUM, LOW] }
 *               labels: { type: array, items: { type: string }, maxItems: 20 }
 *     responses:
 *       200:
 *         description: The updated note.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 note: { $ref: '#/components/schemas/Note' }
 *       400:
 *         description: Invalid input, or the move would create a cycle.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       401:
 *         description: Not authenticated.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       404:
 *         description: Note (or the target parentId) not found.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *   delete:
 *     tags: [Notes]
 *     summary: Delete a note
 *     description: Deletes a note and its entire subtree.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Deleted.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Message' }
 *       401:
 *         description: Not authenticated.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       404:
 *         description: Note not found.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { id } = await params;

  const note = await prisma.note.findFirst({
    where: { id, userId },
    include: {
      children: {
        orderBy: { updatedAt: "desc" },
        select: { id: true, title: true, parentId: true, status: true, createdAt: true, updatedAt: true },
      },
      criteria: { orderBy: { position: "asc" } },
      comments: {
        orderBy: { createdAt: "asc" },
        include: { author: { select: { id: true, name: true, email: true, image: true } } },
      },
    },
  });
  if (!note) {
    return apiError(404, "Note not found");
  }

  return NextResponse.json({ note });
}

export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { id } = await params;

  const existing = await getOwnedNote(userId, id);
  if (!existing) {
    return apiError(404, "Note not found");
  }

  const body = await req.json().catch(() => null);
  const parsed = updateNoteSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(parsed.error);
  }

  const { title, content, parentId, status, priority, labels, sopOverrideId, customFields } = parsed.data;

  if (sopOverrideId && !(await getAccessibleSop(userId, sopOverrideId))) {
    return apiError(400, "SOP not found");
  }

  if (parentId !== undefined && parentId !== null) {
    const parent = await getOwnedNote(userId, parentId);
    if (!parent) {
      return apiError(404, "Note not found");
    }
    if (await wouldCreateCycle(userId, id, parentId)) {
      return apiError(400, "Cannot move a note under itself or one of its own descendants");
    }
  }

  const note = await prisma.$transaction(async (tx) => {
    const updated = await tx.note.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(content !== undefined && { content }),
        ...(parentId !== undefined && { parentId }),
        ...(status !== undefined && { status }),
        ...(priority !== undefined && { priority }),
        ...(labels !== undefined && { labels }),
        ...(sopOverrideId !== undefined && { sopOverrideId }),
        ...(customFields !== undefined && { customFields }),
      },
    });

    // Moving a note or changing its override can change which SOP it should run; a run
    // that still matches keeps its progress.
    const subject = { type: "NOTE", id } as const;
    const moved = parentId !== undefined && parentId !== existing.parentId;
    const overrideChanged = sopOverrideId !== undefined && sopOverrideId !== existing.sopOverrideId;
    if (moved || overrideChanged) await syncAssignedExecution(tx, subject, userId);
    if (status !== undefined && status !== existing.status) {
      await notifySubjectChanged(tx, subject, "SUBJECT_STATUS_CHANGED", userId);
    } else if (labels !== undefined || priority !== undefined || customFields !== undefined) {
      await notifySubjectChanged(tx, subject, "SUBJECT_UPDATED", userId);
    }
    return updated;
  }, ENGINE_TX);

  return NextResponse.json({ note });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { id } = await params;

  const existing = await getOwnedNote(userId, id);
  if (!existing) {
    return apiError(404, "Note not found");
  }

  await prisma.note.delete({ where: { id } });

  return NextResponse.json({ message: "Note deleted" });
}
