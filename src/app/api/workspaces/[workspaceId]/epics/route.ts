import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, apiError } from "@/lib/api";
import { createEpicSchema, epicStatusSchema } from "@/lib/validation";
import { getMembership } from "@/lib/workspaces";

type Params = { params: Promise<{ workspaceId: string }> };

/**
 * @swagger
 * /workspaces/{workspaceId}/epics:
 *   get:
 *     tags: [Planning]
 *     summary: List epics
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/WorkspaceId'
 *       - { in: query, name: status, schema: { type: string, enum: [OPEN, IN_PROGRESS, DONE] } }
 *     responses:
 *       200:
 *         description: The workspace's epics, each with its issue count.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 epics:
 *                   type: array
 *                   items:
 *                     allOf:
 *                       - $ref: '#/components/schemas/Epic'
 *                       - type: object
 *                         properties:
 *                           _count: { type: object, properties: { issues: { type: integer } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   post:
 *     tags: [Planning]
 *     summary: Create an epic
 *     description: Epics span projects within a workspace. startDate/targetDate drive the roadmap/timeline view.
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
 *               name: { type: string, example: "Security Hardening" }
 *               description: { type: string }
 *               color: { type: string, nullable: true }
 *               status: { type: string, enum: [OPEN, IN_PROGRESS, DONE] }
 *               startDate: { type: string, format: date-time, nullable: true }
 *               targetDate: { type: string, format: date-time, nullable: true }
 *     responses:
 *       201:
 *         description: The created epic.
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
 */
export async function GET(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { workspaceId } = await params;

  if (!(await getMembership(userId, workspaceId))) {
    return apiError(404, "Workspace not found");
  }

  const statusParam = new URL(req.url).searchParams.get("status");
  const statusParsed = statusParam ? epicStatusSchema.safeParse(statusParam) : null;
  if (statusParam && !statusParsed?.success) {
    return apiError(400, "Invalid status");
  }

  const epics = await prisma.epic.findMany({
    where: { workspaceId, ...(statusParsed?.success && { status: statusParsed.data }) },
    orderBy: [{ createdAt: "asc" }],
    include: { _count: { select: { issues: true } } },
  });

  return NextResponse.json({ epics });
}

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { workspaceId } = await params;

  if (!(await getMembership(userId, workspaceId))) {
    return apiError(404, "Workspace not found");
  }

  const parsed = await parseJsonBody(req, createEpicSchema);
  if (!parsed.success) return parsed.response;
  const { name, description, color, status, startDate, targetDate } = parsed.data;

  if (startDate && targetDate && startDate > targetDate) {
    return apiError(400, "startDate must be before targetDate");
  }

  const epic = await prisma.epic.create({
    data: { workspaceId, name, description, color: color ?? null, status, startDate: startDate ?? null, targetDate: targetDate ?? null },
  });

  return NextResponse.json({ epic }, { status: 201 });
}
