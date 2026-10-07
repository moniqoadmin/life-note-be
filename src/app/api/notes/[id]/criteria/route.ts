import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError, parseJsonBody } from "@/lib/api";
import { createNoteCriterionSchema } from "@/lib/validation";
import { getOwnedNote } from "@/lib/notes";

type Params = { params: Promise<{ id: string }> };

/**
 * @swagger
 * /notes/{id}/criteria:
 *   post:
 *     tags: [Notes]
 *     summary: Add an acceptance criterion
 *     description: Appends a checklist item to the end of a note's acceptance criteria.
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
 *             required: [text]
 *             properties:
 *               text: { type: string, maxLength: 500 }
 *     responses:
 *       201:
 *         description: The created criterion.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 criterion: { $ref: '#/components/schemas/NoteCriterion' }
 *       400:
 *         description: Invalid input.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
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
export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { id } = await params;

  const note = await getOwnedNote(userId, id);
  if (!note) {
    return apiError(404, "Note not found");
  }

  const parsed = await parseJsonBody(req, createNoteCriterionSchema);
  if (!parsed.success) {
    return parsed.response;
  }

  const last = await prisma.noteCriterion.aggregate({
    where: { noteId: id },
    _max: { position: true },
  });

  const criterion = await prisma.noteCriterion.create({
    data: { noteId: id, text: parsed.data.text, position: (last._max.position ?? -1) + 1 },
  });

  return NextResponse.json({ criterion }, { status: 201 });
}
