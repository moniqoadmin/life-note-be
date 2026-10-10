import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError, parseJsonBody } from "@/lib/api";
import { updateRunbookStepSchema } from "@/lib/validation";
import { getOwnedTask } from "@/lib/tasks";
import { advanceTaskRunbook, recordRunbookEvent } from "@/lib/sop-engine";

type Params = { params: Promise<{ id: string; runbookId: string; stepId: string }> };
const terminal = (status: string) => ["VERIFIED", "SKIPPED"].includes(status);

export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const userId = session.user.id;
  const { id, runbookId, stepId } = await params;
  if (!(await getOwnedTask(userId, id))) return apiError(404, "Task not found");
  const execution = await prisma.issueRunbook.findFirst({ where: { id: runbookId, taskId: id }, include: { steps: { orderBy: { position: "asc" } } } });
  if (!execution) return apiError(404, "Execution not found");
  const step = execution.steps.find((candidate) => candidate.id === stepId);
  if (!step) return apiError(404, "Step not found");
  const parsed = await parseJsonBody(req, updateRunbookStepSchema);
  if (!parsed.success) return parsed.response;
  const { status, notes, output, executor } = parsed.data;
  if (status === "VERIFIED" && step.type === "APPROVAL") return apiError(400, "Use the approval endpoint for approval steps");
  if (status && status !== "PENDING") {
    const blocker = execution.steps.find((candidate) => candidate.position < step.position && !terminal(candidate.status));
    if (blocker) return apiError(409, `Finish step ${blocker.position + 1} first`);
  }
  if (status === "VERIFIED" && step.requiresSignoff && !(notes ?? step.notes).trim()) return apiError(400, "This step requires sign-off notes");

  await prisma.$transaction(async (tx) => {
    const changed = status !== undefined && status !== step.status;
    await tx.runbookStep.update({ where: { id: stepId }, data: {
      ...(status !== undefined && { status }),
      ...(notes !== undefined && { notes }),
      ...(output !== undefined && { output }),
      ...(executor !== undefined && { executor }),
      ...(changed && { completedById: ["PENDING", "IN_PROGRESS"].includes(status) ? null : userId, completedAt: ["PENDING", "IN_PROGRESS"].includes(status) ? null : new Date() }),
    } });
    if (changed) {
      if (status === "FAILED" || status === "BLOCKED") {
        await tx.issueRunbook.update({ where: { id: runbookId }, data: { status, currentStepId: stepId } });
      } else if (status === "IN_PROGRESS") {
        await tx.issueRunbook.update({ where: { id: runbookId }, data: { status: "IN_PROGRESS", currentStepId: stepId } });
      } else if (status === "VERIFIED" || status === "SKIPPED") {
        await recordRunbookEvent(tx, runbookId, userId, status === "VERIFIED" ? "STEP_COMPLETED" : "STEP_SKIPPED", { stepId, notes, output });
        await advanceTaskRunbook(tx, runbookId, id, stepId, userId);
      }
    }
  });
  const updated = await prisma.issueRunbook.findUniqueOrThrow({ where: { id: runbookId }, include: { steps: { orderBy: { position: "asc" } }, events: { orderBy: { createdAt: "asc" } } } });
  return NextResponse.json({ runbook: updated });
}
