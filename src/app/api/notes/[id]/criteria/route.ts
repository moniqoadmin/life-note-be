import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createCriterionSchema } from "@/lib/validation";
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
 *                 criterion: { $ref: '#/components/schemas/AcceptanceCriterion' }
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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { id } = await params;

  const note = await getOwnedNote(userId, id);
  if (!note) {
    return NextResponse.json({ error: "Note not found" }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  const parsed = createCriterionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 }
    );
  }

  const last = await prisma.acceptanceCriterion.aggregate({
    where: { noteId: id },
    _max: { position: true },
  });

  const criterion = await prisma.acceptanceCriterion.create({
    data: { noteId: id, text: parsed.data.text, position: (last._max.position ?? -1) + 1 },
  });

  return NextResponse.json({ criterion }, { status: 201 });
}
