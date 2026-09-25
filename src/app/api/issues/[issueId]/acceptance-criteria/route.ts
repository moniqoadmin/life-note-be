import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody } from "@/lib/api";
import { createCriterionSchema } from "@/lib/validation";
import { getAccessibleIssue } from "@/lib/issues";

type Params = { params: Promise<{ issueId: string }> };

/**
 * @swagger
 * /issues/{issueId}/acceptance-criteria:
 *   get:
 *     tags: [Issue details]
 *     summary: List acceptance criteria
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/IssueId' }]
 *     responses:
 *       200:
 *         description: The checklist, in order.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 criteria: { type: array, items: { $ref: '#/components/schemas/AcceptanceCriterion' } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   post:
 *     tags: [Issue details]
 *     summary: Add an acceptance criterion
 *     description: Appended to the end of the checklist.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/IssueId' }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [text]
 *             properties:
 *               text: { type: string }
 *               done: { type: boolean, default: false }
 *     responses:
 *       201:
 *         description: The created criterion.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 criterion: { $ref: '#/components/schemas/AcceptanceCriterion' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { issueId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return NextResponse.json({ error: "Issue not found" }, { status: 404 });
  }

  const criteria = await prisma.acceptanceCriterion.findMany({
    where: { issueId },
    orderBy: { position: "asc" },
  });

  return NextResponse.json({ criteria });
}

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { issueId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return NextResponse.json({ error: "Issue not found" }, { status: 404 });
  }

  const parsed = await parseJsonBody(req, createCriterionSchema);
  if (!parsed.success) return parsed.response;

  const last = await prisma.acceptanceCriterion.aggregate({
    where: { issueId },
    _max: { position: true },
  });
  const criterion = await prisma.acceptanceCriterion.create({
    data: { issueId, ...parsed.data, position: (last._max.position ?? -1) + 1 },
  });

  return NextResponse.json({ criterion }, { status: 201 });
}
