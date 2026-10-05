import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, apiError } from "@/lib/api";
import { updateComponentSchema } from "@/lib/validation";
import { getAccessibleComponent } from "@/lib/workspaces";

type Params = { params: Promise<{ componentId: string }> };

/**
 * @swagger
 * /components/{componentId}:
 *   patch:
 *     tags: [Projects]
 *     summary: Update a component
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: componentId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *     responses:
 *       200:
 *         description: The updated component.
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
 *   delete:
 *     tags: [Projects]
 *     summary: Delete a component
 *     description: Issues in the component are kept; their component is cleared.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: componentId, required: true, schema: { type: string } }
 *     responses:
 *       200: { $ref: '#/components/responses/Deleted' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { componentId } = await params;

  const existing = await getAccessibleComponent(userId, componentId);
  if (!existing) {
    return apiError(404, "Component not found");
  }

  const parsed = await parseJsonBody(req, updateComponentSchema);
  if (!parsed.success) return parsed.response;
  const { name, description } = parsed.data;

  if (name !== undefined && name !== existing.name) {
    const duplicate = await prisma.component.findUnique({
      where: { projectId_name: { projectId: existing.projectId, name } },
    });
    if (duplicate) {
      return apiError(409, "A component with this name already exists");
    }
  }

  const component = await prisma.component.update({
    where: { id: componentId },
    data: {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
    },
  });

  return NextResponse.json({ component });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { componentId } = await params;

  if (!(await getAccessibleComponent(userId, componentId))) {
    return apiError(404, "Component not found");
  }

  await prisma.component.delete({ where: { id: componentId } });

  return NextResponse.json({ message: "Component deleted" });
}
