import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getAccessibleIssue, recordActivity } from "@/lib/issues";
import { apiError } from "@/lib/api";

type Params = { params: Promise<{ issueId: string; relationId: string }> };

/**
 * @swagger
 * /issues/{issueId}/relations/{relationId}:
 *   delete:
 *     tags: [Issue details]
 *     summary: Unlink an issue
 *     description: Works from either side of the relation.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/IssueId'
 *       - { in: path, name: relationId, required: true, schema: { type: string } }
 *     responses:
 *       200: { $ref: '#/components/responses/Deleted' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { issueId, relationId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return apiError(404, "Issue not found");
  }
  const relation = await prisma.issueRelation.findFirst({
    where: { id: relationId, OR: [{ fromIssueId: issueId }, { toIssueId: issueId }] },
    include: { fromIssue: { select: { key: true } }, toIssue: { select: { key: true } } },
  });
  if (!relation) {
    return apiError(404, "Relation not found");
  }

  const other = relation.fromIssueId === issueId ? relation.toIssue : relation.fromIssue;
  await prisma.$transaction(async (tx) => {
    await tx.issueRelation.delete({ where: { id: relationId } });
    await recordActivity(tx, issueId, userId, "RELATION_REMOVED", {
      type: relation.type,
      issueKey: other.key,
    });
  });

  return NextResponse.json({ message: "Relation removed" });
}
