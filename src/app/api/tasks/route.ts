import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createTaskSchema, taskStatusSchema } from "@/lib/validation";
import { validationError, apiError } from "@/lib/api";
import { ENGINE_TX_OPTIONS, syncTaskAssignment } from "@/lib/sop-engine";
import { listRunbooks } from "@/lib/issues";

/**
 * @swagger
 * /tasks:
 *   get:
 *     tags: [Tasks]
 *     summary: List tasks
 *     description: Lists the caller's tasks, most recently updated first. Optionally filter by status.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [TODO, IN_PROGRESS, DONE] }
 *         description: Only return tasks with this status.
 *     responses:
 *       200:
 *         description: The caller's tasks.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tasks:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Task' }
 *       400:
 *         description: Invalid status filter.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       401:
 *         description: Not authenticated.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *   post:
 *     tags: [Tasks]
 *     summary: Create a task
 *     security: [{ CookieAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title]
 *             properties:
 *               title: { type: string }
 *               content: { type: string }
 *               status: { type: string, enum: [TODO, IN_PROGRESS, DONE], default: TODO }
 *               dueDate: { type: string, format: date-time, nullable: true }
 *     responses:
 *       201:
 *         description: The created task.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 task: { $ref: '#/components/schemas/Task' }
 *       400:
 *         description: Invalid input.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       401:
 *         description: Not authenticated.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;

  const { searchParams } = new URL(req.url);
  const statusParam = searchParams.get("status");
  const statusParsed = statusParam ? taskStatusSchema.safeParse(statusParam) : null;
  if (statusParam && !statusParsed?.success) {
    return apiError(400, "Invalid status");
  }

  const tasks = await prisma.task.findMany({
    where: { userId, ...(statusParsed?.success && { status: statusParsed.data }) },
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json({ tasks });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;

  const body = await req.json().catch(() => null);
  const parsed = createTaskSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(parsed.error);
  }

  const { title, content, status, dueDate, sopOverrideId } = parsed.data;
  if (sopOverrideId) {
    const sop = await prisma.sop.findFirst({ where: { id: sopOverrideId, userId, workspaceId: null } });
    if (!sop) return apiError(400, "Task SOP must be a private SOP owned by you");
  }

  const task = await prisma.$transaction(async (tx) => {
    const created = await tx.task.create({
      data: { userId, title, content, status, dueDate: dueDate ?? null, sopOverrideId: sopOverrideId ?? null },
    });
    await syncTaskAssignment(tx, created.id, userId);
    return created;
  }, ENGINE_TX_OPTIONS);

  return NextResponse.json({ task: { ...task, runbooks: await listRunbooks({ taskId: task.id }) } }, { status: 201 });
}
