import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError, parseJsonBody } from "@/lib/api";
import { createNoteCommentSchema } from "@/lib/validation";
import { getOwnedNote } from "@/lib/notes";

type Params = { params: Promise<{ id: string }> };

const authorSelect = { select: { id: true, name: true, email: true, image: true } } as const;

/**
 * @swagger
 * /notes/{id}/comments:
 *   get:
 *     tags: [Notes]
 *     summary: List comments
 *     description: Returns a note's comments, oldest first, with each author's public profile.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The note's comments.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 comments:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/NoteComment' }
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
 *   post:
 *     tags: [Notes]
 *     summary: Add a comment
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
 *             required: [body]
 *             properties:
 *               body: { type: string, maxLength: 10000 }
 *     responses:
 *       201:
 *         description: The created comment.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 comment: { $ref: '#/components/schemas/NoteComment' }
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
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const { id } = await params;

  const note = await getOwnedNote(session.user.id, id);
  if (!note) {
    return apiError(404, "Note not found");
  }

  const comments = await prisma.noteComment.findMany({
    where: { noteId: id },
    orderBy: { createdAt: "asc" },
    include: { author: authorSelect },
  });

  return NextResponse.json({ comments });
}

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

  const parsed = await parseJsonBody(req, createNoteCommentSchema);
  if (!parsed.success) {
    return parsed.response;
  }

  const comment = await prisma.noteComment.create({
    data: { noteId: id, authorId: userId, body: parsed.data.body },
    include: { author: authorSelect },
  });

  return NextResponse.json({ comment }, { status: 201 });
}
