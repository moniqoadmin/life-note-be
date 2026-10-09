import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { updateNoteSchema } from "@/lib/validation";
import { getOwnedNote, wouldCreateCycle } from "@/lib/notes";
import { getAccessibleSop } from "@/lib/sops";
import { ENGINE_TX_OPTIONS, handleTargetUpdated, syncNoteAssignment } from "@/lib/sop-engine";
import { apiError, validationError } from "@/lib/api";

type Params = { params: Promise<{ id: string }> };

/**
 * @swagger
 * /notes/{id}:
 *   get:
 *     tags: [Notes]
 *     summary: Get a note
 *     description: Returns a note along with its direct children.
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
 *       Updates title/content, and/or moves the note by changing parentId (null moves
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
 *               sopOverrideId: { type: string, nullable: true, description: "This note's own SOP (TASK_OVERRIDE); starts/replaces its execution." }
 *               defaultSopId: { type: string, nullable: true, description: "SOP that notes created under this one inherit (ENTITY_INHERITED)." }
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
        select: { id: true, title: true, parentId: true, createdAt: true, updatedAt: true },
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

  const { title, content, parentId, sopOverrideId, defaultSopId } = parsed.data;

  if (parentId !== undefined && parentId !== null) {
    const parent = await getOwnedNote(userId, parentId);
    if (!parent) {
      return apiError(404, "Note not found");
    }
    if (await wouldCreateCycle(userId, id, parentId)) {
      return apiError(400, "Cannot move a note under itself or one of its own descendants");
    }
  }

  for (const sopId of [sopOverrideId, defaultSopId]) {
    if (sopId && !(await getAccessibleSop(userId, sopId))) {
      return apiError(400, "SOP not found");
    }
  }

  const note = await prisma.$transaction(async (tx) => {
    const updated = await tx.note.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(content !== undefined && { content }),
        ...(parentId !== undefined && { parentId }),
        ...(sopOverrideId !== undefined && { sopOverrideId }),
        ...(defaultSopId !== undefined && { defaultSopId }),
      },
    });
    // Re-resolve when the override or the ancestry changed; the running execution is
    // kept if the resolved SOP is the same. A new defaultSopId only affects notes
    // created under this one from now on.
    const moved = parentId !== undefined && parentId !== existing.parentId;
    if (moved || (sopOverrideId !== undefined && sopOverrideId !== existing.sopOverrideId)) {
      await syncNoteAssignment(tx, id, userId);
    }
    const fields = [title !== undefined && "title", content !== undefined && "content", moved && "parentId"].filter(
      (f): f is string => !!f
    );
    if (fields.length) {
      await handleTargetUpdated(tx, { noteId: id }, { statusChanged: false, fields }, userId);
    }
    return updated;
  }, ENGINE_TX_OPTIONS);

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
