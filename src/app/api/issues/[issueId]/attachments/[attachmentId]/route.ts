import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { canManageWorkspace, getMembership } from "@/lib/workspaces";
import { getAccessibleIssue } from "@/lib/issues";
import { apiError } from "@/lib/api";

type Params = { params: Promise<{ issueId: string; attachmentId: string }> };

/**
 * @swagger
 * /issues/{issueId}/attachments/{attachmentId}:
 *   delete:
 *     tags: [Issue details]
 *     summary: Remove an attachment
 *     description: Uploader, OWNER or ADMIN. Uploaded files are deleted with it; for links only the link is removed.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/IssueId'
 *       - { in: path, name: attachmentId, required: true, schema: { type: string } }
 *     responses:
 *       200: { $ref: '#/components/responses/Deleted' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { issueId, attachmentId } = await params;

  const issue = await getAccessibleIssue(userId, issueId);
  if (!issue) {
    return apiError(404, "Issue not found");
  }
  const existing = await prisma.issueAttachment.findFirst({
    where: { id: attachmentId, issueId },
  });
  if (!existing) {
    return apiError(404, "Attachment not found");
  }
  if (existing.uploaderId !== userId) {
    const membership = await getMembership(userId, issue.workspaceId);
    if (!membership || !canManageWorkspace(membership.role)) {
      return apiError(403, "Only the uploader, owners and admins can remove an attachment");
    }
  }

  await prisma.issueAttachment.delete({ where: { id: attachmentId } });

  return NextResponse.json({ message: "Attachment removed" });
}
