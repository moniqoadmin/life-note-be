import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api";

type Params = { params: Promise<{ id: string; commentId: string }> };

/**
 * @swagger
 * /notes/{id}/comments/{commentId}:
 *   delete:
 *     tags: [Notes]
 *     summary: Delete a comment
 *     description: Deletes a comment. Only the comment's author can delete it.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: commentId
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
 *         description: Comment not found, or not written by the caller.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const { id, commentId } = await params;

  // Scoped to the caller as author, so someone else's comment is indistinguishable
  // from a missing one.
  const existing = await prisma.noteComment.findFirst({
    where: { id: commentId, noteId: id, authorId: session.user.id },
  });
  if (!existing) {
    return apiError(404, "Comment not found");
  }

  await prisma.noteComment.delete({ where: { id: commentId } });

  return NextResponse.json({ message: "Comment deleted" });
}
