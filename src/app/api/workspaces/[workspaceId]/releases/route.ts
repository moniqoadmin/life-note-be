import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, apiError } from "@/lib/api";
import { createReleaseSchema, releaseStatusSchema } from "@/lib/validation";
import { getMembership } from "@/lib/workspaces";

type Params = { params: Promise<{ workspaceId: string }> };

/**
 * @swagger
 * /workspaces/{workspaceId}/releases:
 *   get:
 *     tags: [Planning]
 *     summary: List releases
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/WorkspaceId'
 *       - { in: query, name: status, schema: { type: string, enum: [UNRELEASED, RELEASED, ARCHIVED] } }
 *     responses:
 *       200:
 *         description: The workspace's releases, each with its issue count.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 releases:
 *                   type: array
 *                   items:
 *                     allOf:
 *                       - $ref: '#/components/schemas/Release'
 *                       - type: object
 *                         properties:
 *                           _count: { type: object, properties: { issues: { type: integer } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   post:
 *     tags: [Planning]
 *     summary: Create a release
 *     description: A fix version. Names are unique within a workspace.
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
 *               name: { type: string, example: "v2.4.0" }
 *               description: { type: string }
 *               status: { type: string, enum: [UNRELEASED, RELEASED, ARCHIVED] }
 *               releaseDate: { type: string, format: date-time, nullable: true }
 *     responses:
 *       201:
 *         description: The created release.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 release: { $ref: '#/components/schemas/Release' }
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
  const statusParsed = statusParam ? releaseStatusSchema.safeParse(statusParam) : null;
  if (statusParam && !statusParsed?.success) {
    return apiError(400, "Invalid status");
  }

  const releases = await prisma.release.findMany({
    where: { workspaceId, ...(statusParsed?.success && { status: statusParsed.data }) },
    orderBy: [{ releaseDate: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }],
    include: { _count: { select: { issues: true } } },
  });

  return NextResponse.json({ releases });
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

  const parsed = await parseJsonBody(req, createReleaseSchema);
  if (!parsed.success) return parsed.response;
  const { name, description, status, releaseDate } = parsed.data;

  const duplicate = await prisma.release.findUnique({
    where: { workspaceId_name: { workspaceId, name } },
  });
  if (duplicate) {
    return apiError(409, "A release with this name already exists");
  }

  const release = await prisma.release.create({
    data: { workspaceId, name, description, status, releaseDate: releaseDate ?? null },
  });

  return NextResponse.json({ release }, { status: 201 });
}
