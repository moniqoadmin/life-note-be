import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { updateSopSchema } from "@/lib/validation";
import { getAccessibleSop } from "@/lib/sops";
import { canManageWorkspace, getMembership, userSelect } from "@/lib/workspaces";
import { apiError, validationError } from "@/lib/api";

type Params = { params: Promise<{ id: string }> };

/**
 * @swagger
 * /sops/{id}:
 *   get:
 *     tags: [SOPs]
 *     summary: Get an SOP
 *     description: Your own SOPs, or ones shared into a workspace you belong to. Includes ordered steps and the author.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The SOP.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sop: { $ref: '#/components/schemas/Sop' }
 *       401:
 *         description: Not authenticated.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       404:
 *         description: SOP not found.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *   patch:
 *     tags: [SOPs]
 *     summary: Update an SOP
 *     description: >-
 *       Any workspace member can edit a shared SOP's title/content (bumps `version`). Only the author can
 *       share it (set workspaceId), move it, or make it private again (workspaceId null).
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title: { type: string }
 *               content: { type: string }
 *               workspaceId: { type: string, nullable: true, description: Share with this workspace, or null to make private. Author only. }
 *     responses:
 *       200:
 *         description: The updated SOP.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sop: { $ref: '#/components/schemas/Sop' }
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
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404:
 *         description: SOP not found.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *   delete:
 *     tags: [SOPs]
 *     summary: Delete an SOP
 *     description: The author, or an OWNER/ADMIN of the workspace it's shared in. Runbooks already attached to issues are kept.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
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
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404:
 *         description: SOP not found.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { id } = await params;

  if (!(await getAccessibleSop(userId, id))) {
    return apiError(404, "SOP not found");
  }

  const sop = await prisma.sop.findUnique({
    where: { id },
    include: { steps: { orderBy: { position: "asc" } }, user: { select: userSelect } },
  });

  return NextResponse.json({ sop });
}

export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { id } = await params;

  const existing = await getAccessibleSop(userId, id);
  if (!existing) {
    return apiError(404, "SOP not found");
  }

  const body = await req.json().catch(() => null);
  const parsed = updateSopSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(parsed.error);
  }

  const { title, content, workspaceId } = parsed.data;

  if (workspaceId !== undefined && workspaceId !== existing.workspaceId) {
    if (existing.userId !== userId) {
      return apiError(403, "Only the author can share or unshare an SOP");
    }
    if (workspaceId && !(await getMembership(userId, workspaceId))) {
      return apiError(404, "Workspace not found");
    }
  }

  const sop = await prisma.sop.update({
    where: { id },
    data: {
      ...(title !== undefined && { title }),
      ...(content !== undefined && { content }),
      ...(workspaceId !== undefined && { workspaceId }),
      ...((title !== undefined || content !== undefined) && {
        version: { increment: 1 },
      }),
    },
  });

  return NextResponse.json({ sop });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { id } = await params;

  const existing = await getAccessibleSop(userId, id);
  if (!existing) {
    return apiError(404, "SOP not found");
  }

  if (existing.userId !== userId) {
    const membership = existing.workspaceId
      ? await getMembership(userId, existing.workspaceId)
      : null;
    if (!membership || !canManageWorkspace(membership.role)) {
      return apiError(403, "Only the author, or an owner/admin of its workspace, can delete an SOP");
    }
  }

  await prisma.sop.delete({ where: { id } });

  return NextResponse.json({ message: "SOP deleted" });
}
