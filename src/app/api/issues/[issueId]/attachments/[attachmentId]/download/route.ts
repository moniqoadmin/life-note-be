import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getAccessibleIssue } from "@/lib/issues";
import { contentDisposition } from "@/lib/attachments";
import { apiError } from "@/lib/api";

type Params = { params: Promise<{ issueId: string; attachmentId: string }> };

/**
 * @swagger
 * /issues/{issueId}/attachments/{attachmentId}/download:
 *   get:
 *     tags: [Issue details]
 *     summary: Download an attachment
 *     description: >-
 *       Streams an uploaded file (workspace members only). Images, PDFs and plain text open inline;
 *       everything else downloads. For link attachments, redirects to the external URL.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/IssueId'
 *       - { in: path, name: attachmentId, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: The file.
 *         content:
 *           application/octet-stream:
 *             schema: { type: string, format: binary }
 *       302:
 *         description: Redirect to an external link attachment.
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { issueId, attachmentId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return apiError(404, "Issue not found");
  }
  const attachment = await prisma.issueAttachment.findFirst({
    where: { id: attachmentId, issueId },
  });
  if (!attachment) {
    return apiError(404, "Attachment not found");
  }

  if (attachment.storage === "LINK") {
    return NextResponse.redirect(attachment.url, 302);
  }

  const blob = await prisma.attachmentBlob.findUnique({ where: { attachmentId } });
  if (!blob) {
    return apiError(404, "Attachment not found");
  }

  return new NextResponse(Buffer.from(blob.data), {
    headers: {
      "Content-Type": attachment.mimeType,
      "Content-Length": String(blob.data.byteLength),
      "Content-Disposition": contentDisposition(attachment.fileName, attachment.mimeType),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  });
}
