import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody } from "@/lib/api";
import { updateSprintSchema } from "@/lib/validation";
import { getAccessibleSprint } from "@/lib/workspaces";
import { getPlanningStats } from "@/lib/planning";

type Params = { params: Promise<{ sprintId: string }> };

/**
 * @swagger
 * /sprints/{sprintId}:
 *   get:
 *     tags: [Planning]
 *     summary: Get a sprint
 *     description: Includes progress stats over its issues (counts per status and story points).
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: sprintId, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: The sprint.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sprint:
 *                   allOf:
 *                     - $ref: '#/components/schemas/Sprint'
 *                     - type: object
 *                       properties:
 *                         stats: { $ref: '#/components/schemas/PlanningStats' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   patch:
 *     tags: [Planning]
 *     summary: Update a sprint
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: sprintId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string, example: "Sprint 24" }
 *               goal: { type: string }
 *               status: { type: string, enum: [PLANNED, ACTIVE, COMPLETED] }
 *               startDate: { type: string, format: date-time, nullable: true }
 *               endDate: { type: string, format: date-time, nullable: true }
 *     responses:
 *       200:
 *         description: The updated sprint.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sprint: { $ref: '#/components/schemas/Sprint' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { $ref: '#/components/responses/Conflict' }
 *   delete:
 *     tags: [Planning]
 *     summary: Delete a sprint
 *     description: Its issues move back to the backlog (sprint cleared).
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: sprintId, required: true, schema: { type: string } }
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
  const { sprintId } = await params;

  const sprint = await getAccessibleSprint(userId, sprintId);
  if (!sprint) {
    return NextResponse.json({ error: "Sprint not found" }, { status: 404 });
  }

  const stats = await getPlanningStats({ sprintId: sprintId });
  return NextResponse.json({ sprint: { ...sprint, stats } });
}

export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { sprintId } = await params;

  const existing = await getAccessibleSprint(userId, sprintId);
  if (!existing) {
    return NextResponse.json({ error: "Sprint not found" }, { status: 404 });
  }

  const parsed = await parseJsonBody(req, updateSprintSchema);
  if (!parsed.success) return parsed.response;
  const { name, goal, status, startDate, endDate } = parsed.data;

  const nextStartDate = startDate !== undefined ? startDate : existing.startDate;
  const nextEndDate = endDate !== undefined ? endDate : existing.endDate;
  if (nextStartDate && nextEndDate && nextStartDate > nextEndDate) {
    return NextResponse.json({ error: "startDate must be before endDate" }, { status: 400 });
  }

  if (status === "ACTIVE" && existing.status !== "ACTIVE") {
    const active = await prisma.sprint.findFirst({
      where: { workspaceId: existing.workspaceId, status: "ACTIVE", id: { not: sprintId } },
    });
    if (active) {
      return NextResponse.json({ error: `"${active.name}" is already active` }, { status: 409 });
    }
  }

  const sprint = await prisma.sprint.update({
    where: { id: sprintId },
    data: {
      ...(name !== undefined && { name }),
      ...(goal !== undefined && { goal }),
      ...(status !== undefined && { status }),
      ...(startDate !== undefined && { startDate }),
      ...(endDate !== undefined && { endDate }),
    },
  });

  return NextResponse.json({ sprint });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { sprintId } = await params;

  if (!(await getAccessibleSprint(userId, sprintId))) {
    return NextResponse.json({ error: "Sprint not found" }, { status: 404 });
  }

  await prisma.sprint.delete({ where: { id: sprintId } });

  return NextResponse.json({ message: "Sprint deleted" });
}
