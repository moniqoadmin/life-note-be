import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { updateTaskSchema } from "@/lib/validation";
import { getOwnedTask } from "@/lib/tasks";
import { apiError, validationError } from "@/lib/api";
import { ENGINE_TX_OPTIONS, handleTargetUpdated, syncTaskAssignment } from "@/lib/sop-engine";
import { listRunbooks } from "@/lib/issues";

type Params = { params: Promise<{ id: string }> };

/**
 * @swagger
 * /tasks/{id}:
 *   get:
 *     tags: [Tasks]
 *     summary: Get a task
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The task.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 task: { $ref: '#/components/schemas/Task' }
 *       401:
 *         description: Not authenticated.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       404:
 *         description: Task not found.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *   patch:
 *     tags: [Tasks]
 *     summary: Update a task
 *     description: Updates title, content, status, and/or dueDate.
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title: { type: string }
 *               content: { type: string }
 *               status: { type: string, enum: [TODO, IN_PROGRESS, DONE] }
 *               dueDate: { type: string, format: date-time, nullable: true }
 *     responses:
 *       200:
 *         description: The updated task.
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
 *       404:
 *         description: Task not found.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *   delete:
 *     tags: [Tasks]
 *     summary: Delete a task
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Deleted.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Message' }
 *       401:
 *         description: Not authenticated.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       404:
 *         description: Task not found.
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
  const { id } = await params;

  const task = await getOwnedTask(userId, id);
  if (!task) {
    return apiError(404, "Task not found");
  }

  const runbooks = await listRunbooks({ taskId: id });
  return NextResponse.json({ task: { ...task, runbooks } });
}

export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { id } = await params;

  const existing = await getOwnedTask(userId, id);
  if (!existing) {
    return apiError(404, "Task not found");
  }

  const body = await req.json().catch(() => null);
  const parsed = updateTaskSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(parsed.error);
  }

  const { title, content, status, dueDate, sopOverrideId } = parsed.data;
  if (sopOverrideId) {
    const sop = await prisma.sop.findFirst({ where: { id: sopOverrideId, userId, workspaceId: null } });
    if (!sop) return apiError(400, "Task SOP must be a private SOP owned by you");
  }

  const task = await prisma.$transaction(async (tx) => {
    const updated = await tx.task.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(content !== undefined && { content }),
        ...(status !== undefined && { status }),
        ...(dueDate !== undefined && { dueDate }),
        ...(sopOverrideId !== undefined && { sopOverrideId }),
      },
    });
    if (sopOverrideId !== undefined && sopOverrideId !== existing.sopOverrideId) {
      await syncTaskAssignment(tx, id, userId);
    }
    const fields = Object.keys(parsed.data).filter((f) => f !== "sopOverrideId");
    if (fields.length) {
      await handleTargetUpdated(tx, { taskId: id }, { statusChanged: status !== undefined && status !== existing.status, fields }, userId);
    }
    return updated;
  }, ENGINE_TX_OPTIONS);

  const runbooks = await listRunbooks({ taskId: id });
  return NextResponse.json({ task: { ...task, runbooks } });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { id } = await params;

  const existing = await getOwnedTask(userId, id);
  if (!existing) {
    return apiError(404, "Task not found");
  }

  await prisma.task.delete({ where: { id } });

  return NextResponse.json({ message: "Task deleted" });
}
