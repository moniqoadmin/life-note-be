import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, apiError } from "@/lib/api";
import { createProjectSchema } from "@/lib/validation";
import { getMembership, isWorkspaceMember, userSelect } from "@/lib/workspaces";

type Params = { params: Promise<{ workspaceId: string }> };

/**
 * @swagger
 * /workspaces/{workspaceId}/projects:
 *   get:
 *     tags: [Projects]
 *     summary: List projects
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/WorkspaceId' }]
 *     responses:
 *       200:
 *         description: Projects in the workspace, alphabetically, with their components.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 projects:
 *                   type: array
 *                   items:
 *                     allOf:
 *                       - $ref: '#/components/schemas/Project'
 *                       - type: object
 *                         properties:
 *                           lead: { allOf: [{ $ref: '#/components/schemas/User' }], nullable: true }
 *                           components: { type: array, items: { $ref: '#/components/schemas/Component' } }
 *                           _count: { type: object, properties: { issues: { type: integer } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   post:
 *     tags: [Projects]
 *     summary: Create a project
 *     description: "`key` prefixes every issue key in the project (AUTH → AUTH-1, AUTH-2, …) and can't be changed later."
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/WorkspaceId' }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [key, name]
 *             properties:
 *               key: { type: string, pattern: '^[A-Z][A-Z0-9]{1,9}$', example: AUTH }
 *               name: { type: string, example: "@Auth" }
 *               description: { type: string }
 *               color: { type: string, nullable: true, example: "#3b82f6" }
 *               leadId: { type: string, nullable: true, description: Must be a workspace member. }
 *     responses:
 *       201:
 *         description: The created project.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 project: { $ref: '#/components/schemas/Project' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { workspaceId } = await params;

  if (!(await getMembership(userId, workspaceId))) {
    return apiError(404, "Workspace not found");
  }

  const projects = await prisma.project.findMany({
    where: { workspaceId },
    orderBy: { name: "asc" },
    include: {
      lead: { select: userSelect },
      components: { orderBy: { name: "asc" } },
      _count: { select: { issues: true } },
    },
  });

  return NextResponse.json({ projects });
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

  const parsed = await parseJsonBody(req, createProjectSchema);
  if (!parsed.success) return parsed.response;
  const { key, name, description, color, leadId } = parsed.data;

  if (leadId && !(await isWorkspaceMember(workspaceId, leadId))) {
    return apiError(400, "Lead is not a member of this workspace");
  }

  const existing = await prisma.project.findUnique({
    where: { workspaceId_key: { workspaceId, key } },
  });
  if (existing) {
    return apiError(409, "A project with this key already exists");
  }

  const project = await prisma.project.create({
    data: { workspaceId, key, name, description, color: color ?? null, leadId: leadId ?? null },
  });

  return NextResponse.json({ project }, { status: 201 });
}
