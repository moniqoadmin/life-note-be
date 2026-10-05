import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody, apiError } from "@/lib/api";
import { updateNotificationSchema } from "@/lib/validation";

type Params = { params: Promise<{ notificationId: string }> };

/**
 * @swagger
 * /notifications/{notificationId}:
 *   patch:
 *     tags: [Notifications]
 *     summary: Mark a notification read or unread
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: notificationId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [read]
 *             properties:
 *               read: { type: boolean }
 *     responses:
 *       200:
 *         description: The updated notification.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 notification: { $ref: '#/components/schemas/Notification' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Notifications]
 *     summary: Dismiss a notification
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: notificationId, required: true, schema: { type: string } }
 *     responses:
 *       200: { $ref: '#/components/responses/Deleted' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { notificationId } = await params;

  const existing = await prisma.notification.findFirst({ where: { id: notificationId, userId } });
  if (!existing) {
    return apiError(404, "Notification not found");
  }

  const parsed = await parseJsonBody(req, updateNotificationSchema);
  if (!parsed.success) return parsed.response;

  const notification = await prisma.notification.update({
    where: { id: notificationId },
    data: { readAt: parsed.data.read ? (existing.readAt ?? new Date()) : null },
  });

  return NextResponse.json({ notification });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { notificationId } = await params;

  const { count } = await prisma.notification.deleteMany({ where: { id: notificationId, userId } });
  if (count === 0) {
    return apiError(404, "Notification not found");
  }

  return NextResponse.json({ message: "Notification dismissed" });
}
