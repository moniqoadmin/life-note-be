import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody } from "@/lib/api";
import { updateProjectSchema } from "@/lib/validation";
import {
  canManageWorkspace,
  getAccessibleProject,
  getMembership,
  isWorkspaceMember,
  userSelect,
} from "@/lib/workspaces";

type Params = { params: Promise<{ projectId: string }> };

/**
 * @swagger
 * /projects/{projectId}:
 *   get:
 *     tags: [Projects]
 *     summary: Get a project
 *     description: Includes components, lead and issue counts per status (board column totals).
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/ProjectId' }]
 *     responses:
 *       200:
 *         description: The project.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 project:
 *                   allOf:
 *                     - $ref: '#/components/schemas/Project'
 *                     - type: object
 *                       properties:
 *                         lead: { allOf: [{ $ref: '#/components/schemas/User' }], nullable: true }
 *                         components: { type: array, items: { $ref: '#/components/schemas/Component' } }
 *                         statusCounts:
 *                           type: object
 *                           additionalProperties: { type: integer }
 *                           example: { BACKLOG: 12, IN_PROGRESS: 4, IN_REVIEW: 2, DONE: 30 }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   patch:
 *     tags: [Projects]
 *     summary: Update a project
 *     description: The key can't be changed.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/ProjectId' }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *               color: { type: string, nullable: true }
 *               leadId: { type: string, nullable: true }
 *     responses:
 *       200:
 *         description: The updated project.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 project: { $ref: '#/components/schemas/Project' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Projects]
 *     summary: Delete a project
 *     description: OWNER or ADMIN only. Deletes all of the project's issues.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/ProjectId' }]
 *     responses:
 *       200: { $ref: '#/components/responses/Deleted' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { projectId } = await params;

  if (!(await getAccessibleProject(userId, projectId))) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const [project, grouped] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      include: { lead: { select: userSelect }, components: { orderBy: { name: "asc" } } },
    }),
    prisma.issue.groupBy({ by: ["status"], where: { projectId }, _count: { _all: true } }),
  ]);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const statusCounts = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
  return NextResponse.json({ project: { ...project, statusCounts } });
}

export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { projectId } = await params;

  const existing = await getAccessibleProject(userId, projectId);
  if (!existing) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const parsed = await parseJsonBody(req, updateProjectSchema);
  if (!parsed.success) return parsed.response;
  const { name, description, color, leadId } = parsed.data;

  if (leadId && !(await isWorkspaceMember(existing.workspaceId, leadId))) {
    return NextResponse.json({ error: "Lead is not a member of this workspace" }, { status: 400 });
  }

  const project = await prisma.project.update({
    where: { id: projectId },
    data: {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(color !== undefined && { color }),
      ...(leadId !== undefined && { leadId }),
    },
  });

  return NextResponse.json({ project });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { projectId } = await params;

  const existing = await getAccessibleProject(userId, projectId);
  if (!existing) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const membership = await getMembership(userId, existing.workspaceId);
  if (!membership || !canManageWorkspace(membership.role)) {
    return NextResponse.json({ error: "Only owners and admins can do this" }, { status: 403 });
  }

  await prisma.project.delete({ where: { id: projectId } });

  return NextResponse.json({ message: "Project deleted" });
}
