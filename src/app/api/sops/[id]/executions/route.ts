import { NextResponse } from "next/server";
import type { RunbookStatus } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api";
import { getAccessibleSop } from "@/lib/sops";
import { issueRefSelect } from "@/lib/issues";
import { memberOf } from "@/lib/workspaces";

type Params = { params: Promise<{ id: string }> };

const STATUSES: RunbookStatus[] = ["PENDING", "IN_PROGRESS", "COMPLETED", "FAILED", "SKIPPED", "BLOCKED"];

/**
 * @swagger
 * /sops/{id}/executions:
 *   get:
 *     tags: [SOPs]
 *     summary: List executions of an SOP
 *     description: >-
 *       Every issue/task this SOP is (or was) running against that the caller can see, newest first,
 *       with the current step. Filter with ?status=IN_PROGRESS (repeatable).
 *     security: [{ CookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: query, name: status, schema: { type: string, enum: [PENDING, IN_PROGRESS, COMPLETED, FAILED, SKIPPED, BLOCKED] } }
 *     responses:
 *       200:
 *         description: The executions.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 executions: { type: array, items: { $ref: '#/components/schemas/ExecutionSummary' } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function GET(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { id } = await params;

  if (!(await getAccessibleSop(userId, id))) {
    return apiError(404, "SOP not found");
  }

  const statuses = new URL(req.url).searchParams.getAll("status");
  if (statuses.some((s) => !STATUSES.includes(s as RunbookStatus))) {
    return apiError(400, "Invalid status");
  }

  const executions = await prisma.issueRunbook.findMany({
    where: {
      sopId: id,
      ...(statuses.length && { status: { in: statuses as RunbookStatus[] } }),
      OR: [{ issue: { workspace: memberOf(userId) } }, { task: { userId } }, { note: { userId } }],
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    omit: { definitionSnapshot: true },
    include: {
      issue: { select: issueRefSelect },
      task: { select: { id: true, title: true, status: true } },
      note: { select: { id: true, title: true } },
      steps: { orderBy: { position: "asc" }, select: { id: true, key: true, title: true, type: true, status: true } },
    },
  });

  return NextResponse.json({
    executions: executions.map(({ steps, ...execution }) => ({
      ...execution,
      currentStep: steps.find((s) => s.id === execution.currentStepId) ?? null,
      progress: {
        completed: steps.filter((s) => s.status === "VERIFIED" || s.status === "SKIPPED").length,
        total: steps.length,
      },
    })),
  });
}
