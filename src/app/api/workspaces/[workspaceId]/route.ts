import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, apiError } from "@/lib/api";
import { updateWorkspaceSchema } from "@/lib/validation";
import { canManageWorkspace, getMembership } from "@/lib/workspaces";

type Params = { params: Promise<{ workspaceId: string }> };

/**
 * @swagger
 * /workspaces/{workspaceId}:
 *   get:
 *     tags: [Workspaces]
 *     summary: Get a workspace
 *     description: Includes its projects, the active sprint (if any) and the caller's role.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/WorkspaceId' }]
 *     responses:
 *       200:
 *         description: The workspace.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 workspace:
 *                   allOf:
 *                     - $ref: '#/components/schemas/Workspace'
 *                     - type: object
 *                       properties:
 *                         projects: { type: array, items: { $ref: '#/components/schemas/Project' } }
 *                         activeSprint: { allOf: [{ $ref: '#/components/schemas/Sprint' }], nullable: true }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   patch:
 *     tags: [Workspaces]
 *     summary: Rename a workspace
 *     description: OWNER or ADMIN only.
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
 *               name: { type: string }
 *     responses:
 *       200:
 *         description: The updated workspace.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 workspace: { $ref: '#/components/schemas/Workspace' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Workspaces]
 *     summary: Delete a workspace
 *     description: OWNER only. Deletes every project, issue, sprint, epic and release in it.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/WorkspaceId' }]
 *     responses:
 *       200: { $ref: '#/components/responses/Deleted' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { workspaceId } = await params;

  const membership = await getMembership(userId, workspaceId);
  if (!membership) {
    return apiError(404, "Workspace not found");
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    include: {
      projects: { orderBy: { name: "asc" } },
      sprints: { where: { status: "ACTIVE" }, take: 1 },
    },
  });
  if (!workspace) {
    return apiError(404, "Workspace not found");
  }

  const { sprints, ...rest } = workspace;
  return NextResponse.json({
    workspace: { ...rest, role: membership.role, activeSprint: sprints[0] ?? null },
  });
}

export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { workspaceId } = await params;

  const membership = await getMembership(userId, workspaceId);
  if (!membership) {
    return apiError(404, "Workspace not found");
  }
  if (!canManageWorkspace(membership.role)) {
    return apiError(403, "Only owners and admins can do this");
  }

  const parsed = await parseJsonBody(req, updateWorkspaceSchema);
  if (!parsed.success) return parsed.response;

  const workspace = await prisma.workspace.update({
    where: { id: workspaceId },
    data: { name: parsed.data.name },
  });

  return NextResponse.json({ workspace: { ...workspace, role: membership.role } });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { workspaceId } = await params;

  const membership = await getMembership(userId, workspaceId);
  if (!membership) {
    return apiError(404, "Workspace not found");
  }
  if (membership.role !== "OWNER") {
    return apiError(403, "Only the owner can delete a workspace");
  }

  await prisma.workspace.delete({ where: { id: workspaceId } });

  return NextResponse.json({ message: "Workspace deleted" });
}
