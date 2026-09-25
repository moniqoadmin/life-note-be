import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { listNotificationsQuerySchema } from "@/lib/validation";
import { userSelect } from "@/lib/workspaces";
import { issueRefSelect, queryToObject } from "@/lib/issues";

/**
 * @swagger
 * /notifications:
 *   get:
 *     tags: [Notifications]
 *     summary: List my notifications
 *     description: Newest first, with the unread count for the bell badge.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: query, name: unread, schema: { type: boolean }, description: Only unread notifications. }
 *       - $ref: '#/components/parameters/Limit'
 *       - $ref: '#/components/parameters/Offset'
 *     responses:
 *       200:
 *         description: The caller's notifications.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 notifications: { type: array, items: { $ref: '#/components/schemas/Notification' } }
 *                 total: { type: integer, description: Matching the unread filter, ignoring limit/offset. }
 *                 unreadCount: { type: integer }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const query = listNotificationsQuerySchema.safeParse(
    queryToObject(new URL(req.url).searchParams)
  );
  if (!query.success) {
    return NextResponse.json({ error: "Invalid query" }, { status: 400 });
  }
  const { unread, limit, offset } = query.data;

  const where = { userId, ...(unread && { readAt: null }) };
  const [notifications, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      include: {
        actor: { select: userSelect },
        issue: { select: issueRefSelect },
      },
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);

  return NextResponse.json({ notifications, total, unreadCount });
}
