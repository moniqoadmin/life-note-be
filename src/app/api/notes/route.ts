import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createNoteSchema } from "@/lib/validation";
import { getOwnedNote } from "@/lib/notes";

/**
 * @swagger
 * /notes:
 *   get:
 *     tags: [Notes]
 *     summary: List notes
 *     description: >
 *       Lists a user's notes one level at a time. Omit `parentId` to list root notes;
 *       pass a note's id to list its direct children.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: parentId
 *         schema: { type: string }
 *         description: Id of the parent note. Omit to list root-level notes.
 *     responses:
 *       200:
 *         description: The requested level of the note tree.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 notes:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/NoteSummary' }
 *       401:
 *         description: Not authenticated.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       404:
 *         description: parentId does not refer to one of the caller's notes.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *   post:
 *     tags: [Notes]
 *     summary: Create a note
 *     description: Creates a note, optionally nested under an existing note via parentId.
 *     security: [{ CookieAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title]
 *             properties:
 *               title: { type: string }
 *               content: { type: string }
 *               parentId: { type: string, nullable: true }
 *     responses:
 *       201:
 *         description: The created note.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 note: { $ref: '#/components/schemas/Note' }
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
 *         description: parentId does not refer to one of the caller's notes.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const { searchParams } = new URL(req.url);
  const parentId = searchParams.get("parentId");

  if (parentId) {
    const parent = await getOwnedNote(userId, parentId);
    if (!parent) {
      return NextResponse.json({ error: "Note not found" }, { status: 404 });
    }
  }

  const notes = await prisma.note.findMany({
    where: { userId, parentId: parentId ?? null },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      parentId: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { children: true } },
    },
  });

  return NextResponse.json({
    notes: notes.map(({ _count, ...note }) => ({ ...note, childCount: _count.children })),
  });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const body = await req.json().catch(() => null);
  const parsed = createNoteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 }
    );
  }

  const { title, content, parentId } = parsed.data;

  if (parentId) {
    const parent = await getOwnedNote(userId, parentId);
    if (!parent) {
      return NextResponse.json({ error: "Note not found" }, { status: 404 });
    }
  }

  const note = await prisma.note.create({
    data: { userId, title, content, parentId: parentId ?? null },
  });

  return NextResponse.json({ note }, { status: 201 });
}
