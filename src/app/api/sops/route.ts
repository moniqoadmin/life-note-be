import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createSopSchema } from "@/lib/validation";
import { getMembership, userSelect } from "@/lib/workspaces";
import { apiError, validationError } from "@/lib/api";

/**
 * @swagger
 * /sops:
 *   get:
 *     tags: [SOPs]
 *     summary: List SOPs
 *     description: >-
 *       Without workspaceId, lists SOPs the caller authored (private and shared). With workspaceId,
 *       lists every SOP shared into that workspace, by any author. Most recently updated first.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: query, name: workspaceId, schema: { type: string } }
 *     responses:
 *       200:
 *         description: The SOPs.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sops:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Sop' }
 *       401:
 *         description: Not authenticated.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   post:
 *     tags: [SOPs]
 *     summary: Create an SOP
 *     description: Creates a new SOP at version 1. Pass workspaceId to share it with that workspace; omit it to keep it private.
 *     security: [{ CookieAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title]
 *             properties:
 *               title: { type: string }
 *               content: { type: string }
 *               workspaceId: { type: string, nullable: true, description: Share with this workspace (you must be a member). }
 *     responses:
 *       201:
 *         description: The created SOP.
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
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;

  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (workspaceId && !(await getMembership(userId, workspaceId))) {
    return apiError(404, "Workspace not found");
  }

  const sops = await prisma.sop.findMany({
    where: workspaceId ? { workspaceId } : { userId },
    orderBy: { updatedAt: "desc" },
    include: { user: { select: userSelect } },
  });

  return NextResponse.json({ sops });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;

  const body = await req.json().catch(() => null);
  const parsed = createSopSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(parsed.error);
  }

  const { title, content, workspaceId } = parsed.data;

  if (workspaceId && !(await getMembership(userId, workspaceId))) {
    return apiError(404, "Workspace not found");
  }

  const sop = await prisma.sop.create({
    data: { userId, title, content, workspaceId: workspaceId ?? null },
  });

  return NextResponse.json({ sop }, { status: 201 });
}
