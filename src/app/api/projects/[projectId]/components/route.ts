import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody } from "@/lib/api";
import { createComponentSchema } from "@/lib/validation";
import { getAccessibleProject } from "@/lib/workspaces";

type Params = { params: Promise<{ projectId: string }> };

/**
 * @swagger
 * /projects/{projectId}/components:
 *   get:
 *     tags: [Projects]
 *     summary: List components
 *     description: Sub-areas of a project, e.g. Sessions, OAuth2, 2FA.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/ProjectId' }]
 *     responses:
 *       200:
 *         description: The project's components.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 components: { type: array, items: { $ref: '#/components/schemas/Component' } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   post:
 *     tags: [Projects]
 *     summary: Create a component
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/ProjectId' }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, example: OAuth2 }
 *               description: { type: string }
 *     responses:
 *       201:
 *         description: The created component.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 component: { $ref: '#/components/schemas/Component' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { $ref: '#/components/responses/Conflict' }
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

  const components = await prisma.component.findMany({
    where: { projectId },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({ components });
}

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { projectId } = await params;

  if (!(await getAccessibleProject(userId, projectId))) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const parsed = await parseJsonBody(req, createComponentSchema);
  if (!parsed.success) return parsed.response;
  const { name, description } = parsed.data;

  const duplicate = await prisma.component.findUnique({
    where: { projectId_name: { projectId, name } },
  });
  if (duplicate) {
    return NextResponse.json({ error: "A component with this name already exists" }, { status: 409 });
  }

  const component = await prisma.component.create({ data: { projectId, name, description } });

  return NextResponse.json({ component }, { status: 201 });
}
