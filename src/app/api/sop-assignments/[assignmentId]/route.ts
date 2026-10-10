import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError, parseJsonBody } from "@/lib/api";
import { updateSopAssignmentSchema } from "@/lib/validation";
import { assignmentInclude, scopeAccess, scopeOf } from "@/lib/sop/assignments";

type Params = { params: Promise<{ assignmentId: string }> };

async function loadForUser(userId: string, assignmentId: string) {
  const assignment = await prisma.sopAssignment.findUnique({ where: { id: assignmentId } });
  if (!assignment) return null;
  const access = await scopeAccess(userId, scopeOf(assignment));
  return access ? { assignment, access } : null;
}

/**
 * @swagger
 * /sop-assignments/{assignmentId}:
 *   patch:
 *     tags: [SOP Assignments]
 *     summary: Change an entity default (SOP, condition, priority)
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ in: path, name: assignmentId, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: "{ assignment }" }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [SOP Assignments]
 *     summary: Remove an entity default
 *     description: Running executions are kept; only future resolution changes.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ in: path, name: assignmentId, required: true, schema: { type: string } }]
 *     responses:
 *       200: { $ref: '#/components/responses/Deleted' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const { assignmentId } = await params;
  const found = await loadForUser(session.user.id, assignmentId);
  if (!found) return apiError(404, "Assignment not found");

  const parsed = await parseJsonBody(req, updateSopAssignmentSchema);
  if (!parsed.success) return parsed.response;
  const { sopId, condition, priority } = parsed.data;
  if (sopId && !(await found.access.canUseSop(sopId))) return apiError(400, "That SOP isn't available for this entity");

  const assignment = await prisma.sopAssignment.update({
    where: { id: assignmentId },
    data: {
      ...(sopId !== undefined && { sopId }),
      ...(priority !== undefined && { priority }),
      ...(condition !== undefined && { condition: condition === null ? Prisma.DbNull : (condition as Prisma.InputJsonValue) }),
    },
    include: assignmentInclude,
  });
  return NextResponse.json({ assignment });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const { assignmentId } = await params;
  if (!(await loadForUser(session.user.id, assignmentId))) return apiError(404, "Assignment not found");
  await prisma.sopAssignment.delete({ where: { id: assignmentId } });
  return NextResponse.json({ message: "Assignment removed" });
}
