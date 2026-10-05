import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { searchNotesSchema } from "@/lib/validation";
import { getOwnedNote, searchNotes } from "@/lib/notes";
import { apiError, validationError } from "@/lib/api";

/**
 * @swagger
 * /notes/search:
 *   get:
 *     tags: [Notes]
 *     summary: Search notes
 *     description: >
 *       Full-text search across a user's entire note tree, matching regardless of how
 *       deeply a note is nested. Each hit includes its ancestor breadcrumb (e.g.
 *       "Work > Projects > Q3 Plan") so results stay meaningful outside their place in
 *       the tree. Pass rootId to scope the search to one note's subtree instead.
 *       Backed by a Postgres GIN full-text index, so cost scales with match count, not
 *       with total note count.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string }
 *         description: Search query (supports quoted phrases, "-word" exclusion, OR).
 *       - in: query
 *         name: rootId
 *         schema: { type: string }
 *         description: Restrict results to this note's descendants.
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 50, default: 20 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, minimum: 0, default: 0 }
 *     responses:
 *       200:
 *         description: Ranked search hits with breadcrumbs.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 results:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/NoteSearchHit' }
 *                 limit: { type: integer }
 *                 offset: { type: integer }
 *                 hasMore: { type: boolean }
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
 *         description: rootId does not refer to one of the caller's notes.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;

  const { searchParams } = new URL(req.url);
  const parsed = searchNotesSchema.safeParse({
    q: searchParams.get("q") ?? undefined,
    rootId: searchParams.get("rootId"),
    limit: searchParams.get("limit") ?? undefined,
    offset: searchParams.get("offset") ?? undefined,
  });
  if (!parsed.success) {
    return validationError(parsed.error);
  }

  const { q, rootId, limit, offset } = parsed.data;

  if (rootId) {
    const root = await getOwnedNote(userId, rootId);
    if (!root) {
      return apiError(404, "Note not found");
    }
  }

  const { hits, hasMore } = await searchNotes(userId, { q, rootId, limit, offset });

  return NextResponse.json({
    results: hits,
    limit,
    offset,
    hasMore,
  });
}
