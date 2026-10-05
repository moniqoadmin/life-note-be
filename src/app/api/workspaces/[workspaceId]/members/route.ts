import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, apiError } from "@/lib/api";
import { addMemberSchema } from "@/lib/validation";
import { canManageWorkspace, getMembership, userSelect } from "@/lib/workspaces";

type Params = { params: Promise<{ workspaceId: string }> };

/**
 * @swagger
 * /workspaces/{workspaceId}/members:
 *   get:
 *     tags: [Workspaces]
 *     summary: List members
 *     description: Everyone in the workspace — use for assignee pickers and @mention autocomplete (with q).
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/WorkspaceId'
 *       - { in: query, name: q, schema: { type: string }, description: Case-insensitive match on name or email. }
 *     responses:
 *       200:
 *         description: The members.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 members: { type: array, items: { $ref: '#/components/schemas/WorkspaceMember' } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   post:
 *     tags: [Workspaces]
 *     summary: Add a member
 *     description: OWNER or ADMIN only. The user must already have an account.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/WorkspaceId' }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *               role: { type: string, enum: [ADMIN, MEMBER], default: MEMBER }
 *     responses:
 *       201:
 *         description: The new member.
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

  const q = new URL(req.url).searchParams.get("q")?.trim().slice(0, 100);

  const members = await prisma.workspaceMember.findMany({
    where: {
      workspaceId,
      ...(q && {
        user: {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
          ],
        },
      }),
    },
    orderBy: { createdAt: "asc" },
    select: { userId: true, role: true, createdAt: true, user: { select: userSelect } },
  });

  return NextResponse.json({ members });
}

export async function POST(req: Request, { params }: Params) {
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

  const parsed = await parseJsonBody(req, addMemberSchema);
  if (!parsed.success) return parsed.response;
  const { email, role } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) {
    return apiError(404, "No user with that email");
  }
  if (await getMembership(user.id, workspaceId)) {
    return apiError(409, "User is already a member");
  }

  const member = await prisma.workspaceMember.create({
    data: { workspaceId, userId: user.id, role },
    select: { userId: true, role: true, createdAt: true, user: { select: userSelect } },
  });

  return NextResponse.json({ member }, { status: 201 });
}
