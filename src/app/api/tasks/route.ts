import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createTaskSchema, taskStatusSchema } from "@/lib/validation";

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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const { searchParams } = new URL(req.url);
  const statusParam = searchParams.get("status");
  const statusParsed = statusParam ? taskStatusSchema.safeParse(statusParam) : null;
  if (statusParam && !statusParsed?.success) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const body = await req.json().catch(() => null);
  const parsed = createTaskSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 }
    );
  }

  const { title, content, status, dueDate } = parsed.data;

  const task = await prisma.task.create({
    data: { userId, title, content, status, dueDate: dueDate ?? null },
  });

  return NextResponse.json({ task }, { status: 201 });
}
