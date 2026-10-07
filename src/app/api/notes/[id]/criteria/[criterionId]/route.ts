import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError, parseJsonBody } from "@/lib/api";
import { updateNoteCriterionSchema } from "@/lib/validation";

type Params = { params: Promise<{ id: string; criterionId: string }> };

/** Looks the criterion up through its note so another user's ids always 404. */
function getOwnedCriterion(userId: string, noteId: string, criterionId: string) {
  return prisma.noteCriterion.findFirst({
    where: { id: criterionId, noteId, note: { userId } },
  });
}

/**
 * @swagger
 * /notes/{id}/criteria/{criterionId}:
 *   patch:
 *     tags: [Notes]
 *     summary: Update an acceptance criterion
 *     description: Edits a criterion's text and/or ticks it off.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: criterionId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               text: { type: string, maxLength: 500 }
 *               done: { type: boolean }
 *     responses:
 *       200:
 *         description: The updated criterion.
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
 *         description: Note or criterion not found.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *   delete:
 *     tags: [Notes]
 *     summary: Delete an acceptance criterion
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: criterionId
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
 *         description: Note or criterion not found.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const { id, criterionId } = await params;

  const existing = await getOwnedCriterion(session.user.id, id, criterionId);
  if (!existing) {
    return apiError(404, "Criterion not found");
  }

  const parsed = await parseJsonBody(req, updateNoteCriterionSchema);
  if (!parsed.success) {
    return parsed.response;
  }

  const criterion = await prisma.noteCriterion.update({
    where: { id: criterionId },
    data: parsed.data,
  });

  return NextResponse.json({ criterion });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const { id, criterionId } = await params;

  const existing = await getOwnedCriterion(session.user.id, id, criterionId);
  if (!existing) {
    return apiError(404, "Criterion not found");
  }

  await prisma.noteCriterion.delete({ where: { id: criterionId } });

  return NextResponse.json({ message: "Criterion deleted" });
}
