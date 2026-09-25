import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody } from "@/lib/api";
import { updateReleaseSchema } from "@/lib/validation";
import { getAccessibleRelease } from "@/lib/workspaces";
import { getPlanningStats } from "@/lib/planning";

type Params = { params: Promise<{ releaseId: string }> };

/**
 * @swagger
 * /releases/{releaseId}:
 *   get:
 *     tags: [Planning]
 *     summary: Get a release
 *     description: Includes progress stats over its issues (counts per status and story points).
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: releaseId, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: The release.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 release:
 *                   allOf:
 *                     - $ref: '#/components/schemas/Release'
 *                     - type: object
 *                       properties:
 *                         stats: { $ref: '#/components/schemas/PlanningStats' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   patch:
 *     tags: [Planning]
 *     summary: Update a release
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: releaseId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string, example: "v2.4.0" }
 *               description: { type: string }
 *               status: { type: string, enum: [UNRELEASED, RELEASED, ARCHIVED] }
 *               releaseDate: { type: string, format: date-time, nullable: true }
 *     responses:
 *       200:
 *         description: The updated release.
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
 *   delete:
 *     tags: [Planning]
 *     summary: Delete a release
 *     description: Its issues are kept; their fix version is cleared.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: releaseId, required: true, schema: { type: string } }
 *     responses:
 *       200: { $ref: '#/components/responses/Deleted' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { releaseId } = await params;

  const release = await getAccessibleRelease(userId, releaseId);
  if (!release) {
    return NextResponse.json({ error: "Release not found" }, { status: 404 });
  }

  const stats = await getPlanningStats({ releaseId: releaseId });
  return NextResponse.json({ release: { ...release, stats } });
}

export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { releaseId } = await params;

  const existing = await getAccessibleRelease(userId, releaseId);
  if (!existing) {
    return NextResponse.json({ error: "Release not found" }, { status: 404 });
  }

  const parsed = await parseJsonBody(req, updateReleaseSchema);
  if (!parsed.success) return parsed.response;
  const { name, description, status, releaseDate } = parsed.data;

  if (name !== undefined && name !== existing.name) {
    const duplicate = await prisma.release.findUnique({
      where: { workspaceId_name: { workspaceId: existing.workspaceId, name } },
    });
    if (duplicate) {
      return NextResponse.json(
        { error: "A release with this name already exists" },
        { status: 409 }
      );
    }
  }

  const release = await prisma.release.update({
    where: { id: releaseId },
    data: {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(status !== undefined && { status }),
      ...(releaseDate !== undefined && { releaseDate }),
    },
  });

  return NextResponse.json({ release });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { releaseId } = await params;

  if (!(await getAccessibleRelease(userId, releaseId))) {
    return NextResponse.json({ error: "Release not found" }, { status: 404 });
  }

  await prisma.release.delete({ where: { id: releaseId } });

  return NextResponse.json({ message: "Release deleted" });
}
