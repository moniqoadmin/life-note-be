import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api";
import { getAccessibleIssue } from "@/lib/issues";
import { OPEN_EXECUTION_STATUSES, resolveIssueSop } from "@/lib/sop-engine";

type Params = { params: Promise<{ issueId: string }> };

/**
 * @swagger
 * /issues/{issueId}/sop:
 *   get:
 *     tags: [Runbooks]
 *     summary: Resolve the issue's SOP
 *     description: >-
 *       Which SOP applies to this issue and why — the issue's own override (TASK_OVERRIDE), else its
 *       component's default (ENTITY_INHERITED), else none — plus the active automatically assigned
 *       execution, if any. Set the override with PATCH /issues/{issueId} { sopOverrideId } and the
 *       entity default with PATCH /components/{componentId} { defaultSopId }.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/IssueId' }]
 *     responses:
 *       200:
 *         description: The resolution.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 assignment:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     assignmentType: { type: string, enum: [TASK_OVERRIDE, ENTITY_INHERITED] }
 *                     source: { type: object, nullable: true, properties: { type: { type: string, enum: [COMPONENT] }, id: { type: string } } }
 *                     sop: { type: object, properties: { id: { type: string }, title: { type: string }, version: { type: integer } } }
 *                 activeExecution:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     id: { type: string }
 *                     status: { type: string }
 *                     sopId: { type: string, nullable: true }
 *                     assignmentType: { type: string }
 *                     currentStepId: { type: string, nullable: true }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const { issueId } = await params;

  const issue = await getAccessibleIssue(session.user.id, issueId);
  if (!issue) {
    return apiError(404, "Issue not found");
  }

  const resolution = await resolveIssueSop(prisma, issue);
  const [sop, activeExecution] = await Promise.all([
    resolution
      ? prisma.sop.findUnique({ where: { id: resolution.sopId }, select: { id: true, title: true, version: true } })
      : null,
    prisma.issueRunbook.findFirst({
      where: {
        issueId,
        assignmentType: { in: ["TASK_OVERRIDE", "ENTITY_INHERITED"] },
        status: { in: OPEN_EXECUTION_STATUSES },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, sopId: true, sopVersion: true, assignmentType: true, currentStepId: true },
    }),
  ]);

  return NextResponse.json({
    assignment: resolution && sop
      ? { assignmentType: resolution.assignmentType, source: resolution.source, sop }
      : null,
    activeExecution,
  });
}
