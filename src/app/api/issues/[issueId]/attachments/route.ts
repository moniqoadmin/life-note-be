import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, apiError } from "@/lib/api";
import { createAttachmentSchema } from "@/lib/validation";
import { userSelect } from "@/lib/workspaces";
import { getAccessibleIssue, recordActivity } from "@/lib/issues";
import { downloadPath, MAX_UPLOAD_BYTES, normalizeMimeType } from "@/lib/attachments";

type Params = { params: Promise<{ issueId: string }> };

/**
 * @swagger
 * /issues/{issueId}/attachments:
 *   get:
 *     tags: [Issue details]
 *     summary: List attachments
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/IssueId' }]
 *     responses:
 *       200:
 *         description: The attachments, newest first.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 attachments: { type: array, items: { $ref: '#/components/schemas/IssueAttachment' } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   post:
 *     tags: [Issue details]
 *     summary: Upload a file or add a link
 *     description: >-
 *       Send multipart/form-data with a `file` field (max 10 MB) to upload — the file is stored by this
 *       API and served from the returned `url` (the download endpoint, members only). Or send JSON to
 *       attach an external http(s) link without uploading anything.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/IssueId' }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file: { type: string, format: binary }
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fileName, mimeType, sizeBytes, url]
 *             properties:
 *               fileName: { type: string }
 *               mimeType: { type: string, example: image/png }
 *               sizeBytes: { type: integer }
 *               url: { type: string, format: uri }
 *     responses:
 *       201:
 *         description: The attachment.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 attachment: { $ref: '#/components/schemas/IssueAttachment' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       413:
 *         description: File is larger than 10 MB.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { issueId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return apiError(404, "Issue not found");
  }

  const attachments = await prisma.issueAttachment.findMany({
    where: { issueId },
    orderBy: { createdAt: "desc" },
    include: { uploader: { select: userSelect } },
  });

  return NextResponse.json({ attachments });
}

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { issueId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return apiError(404, "Issue not found");
  }

  if (req.headers.get("content-type")?.startsWith("multipart/form-data")) {
    return uploadFile(req, issueId, userId);
  }

  const parsed = await parseJsonBody(req, createAttachmentSchema);
  if (!parsed.success) return parsed.response;

  const attachment = await prisma.$transaction(async (tx) => {
    const created = await tx.issueAttachment.create({
      data: { issueId, uploaderId: userId, storage: "LINK", ...parsed.data },
      include: { uploader: { select: userSelect } },
    });
    await recordActivity(tx, issueId, userId, "ATTACHMENT_ADDED", {
      attachmentId: created.id,
      fileName: created.fileName,
    });
    return created;
  });

  return NextResponse.json({ attachment }, { status: 201 });
}

async function uploadFile(req: Request, issueId: string, userId: string) {
  // Reject obviously oversized bodies before buffering them.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_UPLOAD_BYTES + 64 * 1024) {
    return apiError(413, "File is larger than 10 MB");
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return apiError(400, "Missing file field");
  }
  if (file.size === 0) {
    return apiError(400, "File is empty");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return apiError(413, "File is larger than 10 MB");
  }

  const fileName = (file.name || "file").slice(0, 255);
  const mimeType = normalizeMimeType(file.type);
  const data = new Uint8Array(await file.arrayBuffer());

  const attachment = await prisma.$transaction(async (tx) => {
    const created = await tx.issueAttachment.create({
      data: {
        issueId,
        uploaderId: userId,
        storage: "UPLOAD",
        fileName,
        mimeType,
        sizeBytes: file.size,
        url: "",
        blob: { create: { data } },
      },
    });
    await recordActivity(tx, issueId, userId, "ATTACHMENT_ADDED", {
      attachmentId: created.id,
      fileName,
    });
    return tx.issueAttachment.update({
      where: { id: created.id },
      data: { url: downloadPath(issueId, created.id) },
      include: { uploader: { select: userSelect } },
    });
  });

  return NextResponse.json({ attachment }, { status: 201 });
}
