import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, apiError } from "@/lib/api";
import { createWorkspaceSchema } from "@/lib/validation";

/**
 * @swagger
 * /workspaces:
 *   get:
 *     tags: [Workspaces]
 *     summary: List my workspaces
 *     description: Workspaces the caller is a member of, with the caller's role in each.
 *     security: [{ CookieAuth: [] }]
 *     responses:
 *       200:
 *         description: The caller's workspaces.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 workspaces:
 *                   type: array
 *                   items:
 *                     allOf:
 *                       - $ref: '#/components/schemas/Workspace'
 *                       - type: object
 *                         properties:
 *                           _count:
 *                             type: object
 *                             properties:
 *                               members: { type: integer }
 *                               projects: { type: integer }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   post:
 *     tags: [Workspaces]
 *     summary: Create a workspace
 *     description: The caller becomes its OWNER.
 *     security: [{ CookieAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, example: Core Platform }
 *     responses:
 *       201:
 *         description: The created workspace.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 workspace: { $ref: '#/components/schemas/Workspace' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    include: {
      workspace: { include: { _count: { select: { members: true, projects: true } } } },
    },
  });

  const workspaces = memberships.map((m) => ({ ...m.workspace, role: m.role }));
  return NextResponse.json({ workspaces });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;

  const parsed = await parseJsonBody(req, createWorkspaceSchema);
  if (!parsed.success) return parsed.response;

  const workspace = await prisma.workspace.create({
    data: { name: parsed.data.name, members: { create: { userId, role: "OWNER" } } },
  });

  return NextResponse.json({ workspace: { ...workspace, role: "OWNER" } }, { status: 201 });
}
