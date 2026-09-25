import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody } from "@/lib/api";
import { createSprintSchema, sprintStatusSchema } from "@/lib/validation";
import { getMembership } from "@/lib/workspaces";

type Params = { params: Promise<{ workspaceId: string }> };

/**
 * @swagger
 * /workspaces/{workspaceId}/sprints:
 *   get:
 *     tags: [Planning]
 *     summary: List sprints
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/WorkspaceId'
 *       - { in: query, name: status, schema: { type: string, enum: [PLANNED, ACTIVE, COMPLETED] } }
 *     responses:
 *       200:
 *         description: The workspace's sprints, each with its issue count.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sprints:
 *                   type: array
 *                   items:
 *                     allOf:
 *                       - $ref: '#/components/schemas/Sprint'
 *                       - type: object
 *                         properties:
 *                           _count: { type: object, properties: { issues: { type: integer } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   post:
 *     tags: [Planning]
 *     summary: Create a sprint
 *     description: Only one sprint per workspace can be ACTIVE at a time.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/WorkspaceId' }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, example: "Sprint 24" }
 *               goal: { type: string }
 *               status: { type: string, enum: [PLANNED, ACTIVE, COMPLETED] }
 *               startDate: { type: string, format: date-time, nullable: true }
 *               endDate: { type: string, format: date-time, nullable: true }
 *     responses:
 *       201:
 *         description: The created sprint.
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
 */
export async function GET(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { workspaceId } = await params;

  if (!(await getMembership(userId, workspaceId))) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const statusParam = new URL(req.url).searchParams.get("status");
  const statusParsed = statusParam ? sprintStatusSchema.safeParse(statusParam) : null;
  if (statusParam && !statusParsed?.success) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const sprints = await prisma.sprint.findMany({
    where: { workspaceId, ...(statusParsed?.success && { status: statusParsed.data }) },
    orderBy: [{ status: "asc" }, { startDate: "desc" }, { createdAt: "desc" }],
    include: { _count: { select: { issues: true } } },
  });

  return NextResponse.json({ sprints });
}

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { workspaceId } = await params;

  if (!(await getMembership(userId, workspaceId))) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const parsed = await parseJsonBody(req, createSprintSchema);
  if (!parsed.success) return parsed.response;
  const { name, goal, status, startDate, endDate } = parsed.data;

  if (startDate && endDate && startDate > endDate) {
    return NextResponse.json({ error: "startDate must be before endDate" }, { status: 400 });
  }

  if (status === "ACTIVE") {
    const active = await prisma.sprint.findFirst({ where: { workspaceId, status: "ACTIVE" } });
    if (active) {
      return NextResponse.json({ error: `"${active.name}" is already active` }, { status: 409 });
    }
  }

  const sprint = await prisma.sprint.create({
    data: { workspaceId, name, goal, status, startDate: startDate ?? null, endDate: endDate ?? null },
  });

  return NextResponse.json({ sprint }, { status: 201 });
}
