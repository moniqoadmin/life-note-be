import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody } from "@/lib/api";
import { updateMemberSchema } from "@/lib/validation";
import { canManageWorkspace, getMembership, userSelect } from "@/lib/workspaces";

type Params = { params: Promise<{ workspaceId: string; userId: string }> };

/**
 * @swagger
 * /workspaces/{workspaceId}/members/{userId}:
 *   patch:
 *     tags: [Workspaces]
 *     summary: Change a member's role
 *     description: OWNER or ADMIN only. The OWNER's role can't be changed.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/WorkspaceId'
 *       - { in: path, name: userId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [role]
 *             properties:
 *               role: { type: string, enum: [ADMIN, MEMBER] }
 *     responses:
 *       200:
 *         description: The updated member.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 member: { $ref: '#/components/schemas/WorkspaceMember' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Workspaces]
 *     summary: Remove a member (or leave)
 *     description: OWNER/ADMIN can remove anyone except the OWNER; any member can remove themselves. The removed user's issues in this workspace become unassigned, and they stop leading any of its projects.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/WorkspaceId'
 *       - { in: path, name: userId, required: true, schema: { type: string } }
 *     responses:
 *       200: { $ref: '#/components/responses/Deleted' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const callerId = session.user.id;
  const { workspaceId, userId } = await params;

  const membership = await getMembership(callerId, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }
  if (!canManageWorkspace(membership.role)) {
    return NextResponse.json({ error: "Only owners and admins can do this" }, { status: 403 });
  }

  const target = await getMembership(userId, workspaceId);
  if (!target) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }
  if (target.role === "OWNER") {
    return NextResponse.json({ error: "The owner's role can't be changed" }, { status: 403 });
  }

  const parsed = await parseJsonBody(req, updateMemberSchema);
  if (!parsed.success) return parsed.response;

  const member = await prisma.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId, userId } },
    data: { role: parsed.data.role },
    select: { userId: true, role: true, createdAt: true, user: { select: userSelect } },
  });

  return NextResponse.json({ member });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const callerId = session.user.id;
  const { workspaceId, userId } = await params;

  const membership = await getMembership(callerId, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const target = await getMembership(userId, workspaceId);
  if (!target) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }
  if (target.role === "OWNER") {
    return NextResponse.json(
      { error: "The owner can't be removed; delete the workspace instead" },
      { status: 403 }
    );
  }
  if (userId !== callerId && !canManageWorkspace(membership.role)) {
    return NextResponse.json({ error: "Only owners and admins can do this" }, { status: 403 });
  }

  await prisma.$transaction([
    prisma.issue.updateMany({
      where: { workspaceId, assigneeId: userId },
      data: { assigneeId: null },
    }),
    prisma.project.updateMany({ where: { workspaceId, leadId: userId }, data: { leadId: null } }),
    prisma.issueWatcher.deleteMany({ where: { userId, issue: { workspaceId } } }),
    prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId } } }),
  ]);

  return NextResponse.json({ message: "Member removed" });
}
