import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody } from "@/lib/api";
import { updateEpicSchema } from "@/lib/validation";
import { getAccessibleEpic } from "@/lib/workspaces";
import { getPlanningStats } from "@/lib/planning";

type Params = { params: Promise<{ epicId: string }> };

/**
 * @swagger
 * /epics/{epicId}:
 *   get:
 *     tags: [Planning]
 *     summary: Get an epic
 *     description: Includes progress stats over its issues (counts per status and story points).
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: epicId, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: The epic.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 epic:
 *                   allOf:
 *                     - $ref: '#/components/schemas/Epic'
 *                     - type: object
 *                       properties:
 *                         stats: { $ref: '#/components/schemas/PlanningStats' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   patch:
 *     tags: [Planning]
 *     summary: Update an epic
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: epicId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string, example: "Security Hardening" }
 *               description: { type: string }
 *               color: { type: string, nullable: true }
 *               status: { type: string, enum: [OPEN, IN_PROGRESS, DONE] }
 *               startDate: { type: string, format: date-time, nullable: true }
 *               targetDate: { type: string, format: date-time, nullable: true }
 *     responses:
 *       200:
 *         description: The updated epic.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 epic: { $ref: '#/components/schemas/Epic' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { $ref: '#/components/responses/Conflict' }
 *   delete:
 *     tags: [Planning]
 *     summary: Delete an epic
 *     description: Its issues are kept; their epic is cleared.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: epicId, required: true, schema: { type: string } }
 *     responses:
 *       200: { $ref: '#/components/responses/Deleted' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { epicId } = await params;

  const epic = await getAccessibleEpic(userId, epicId);
  if (!epic) {
    return NextResponse.json({ error: "Epic not found" }, { status: 404 });
  }

  const stats = await getPlanningStats({ epicId: epicId });
  return NextResponse.json({ epic: { ...epic, stats } });
}

export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { epicId } = await params;

  const existing = await getAccessibleEpic(userId, epicId);
  if (!existing) {
    return NextResponse.json({ error: "Epic not found" }, { status: 404 });
  }

  const parsed = await parseJsonBody(req, updateEpicSchema);
  if (!parsed.success) return parsed.response;
  const { name, description, color, status, startDate, targetDate } = parsed.data;

  const nextStartDate = startDate !== undefined ? startDate : existing.startDate;
  const nextTargetDate = targetDate !== undefined ? targetDate : existing.targetDate;
  if (nextStartDate && nextTargetDate && nextStartDate > nextTargetDate) {
    return NextResponse.json({ error: "startDate must be before targetDate" }, { status: 400 });
  }

  const epic = await prisma.epic.update({
    where: { id: epicId },
    data: {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(color !== undefined && { color }),
      ...(status !== undefined && { status }),
      ...(startDate !== undefined && { startDate }),
      ...(targetDate !== undefined && { targetDate }),
    },
  });

  return NextResponse.json({ epic });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { epicId } = await params;

  if (!(await getAccessibleEpic(userId, epicId))) {
    return NextResponse.json({ error: "Epic not found" }, { status: 404 });
  }

  await prisma.epic.delete({ where: { id: epicId } });

  return NextResponse.json({ message: "Epic deleted" });
}
