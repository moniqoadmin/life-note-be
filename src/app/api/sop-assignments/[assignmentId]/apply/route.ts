import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api";
import { scopeAccess, scopeOf, subjectsInScope } from "@/lib/sop/assignments";
import { ENGINE_TX, syncAssignedExecution } from "@/lib/sop/engine";

type Params = { params: Promise<{ assignmentId: string }> };

/**
 * @swagger
 * /sop-assignments/{assignmentId}/apply:
 *   post:
 *     tags: [SOP Assignments]
 *     summary: Re-resolve the SOP of existing tasks under this entity
 *     description: >-
 *       Runs SOP resolution again for every task under the entity (up to 500): tasks that should
 *       now run a different SOP get a new execution (the old one is cancelled, kept for history);
 *       tasks already running the right SOP keep their progress; overrides still win.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ in: path, name: assignmentId, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: "{ checked, changed, failed }" }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function POST(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const userId = session.user.id;
  const { assignmentId } = await params;
  const assignment = await prisma.sopAssignment.findUnique({ where: { id: assignmentId } });
  if (!assignment || !(await scopeAccess(userId, scopeOf(assignment)))) return apiError(404, "Assignment not found");

  const subjects = await subjectsInScope(scopeOf(assignment));
  let changed = 0;
  let failed = 0;
  // One transaction per subject keeps each short and lets the rest proceed if one fails.
  for (const subject of subjects) {
    try {
      const result = await prisma.$transaction((tx) => syncAssignedExecution(tx, subject, userId), ENGINE_TX);
      if (result.changed) changed++;
    } catch (error) {
      failed++;
      console.error(`SOP apply failed for ${subject.type} ${subject.id}:`, error);
    }
  }
  return NextResponse.json({ checked: subjects.length, changed, failed });
}
