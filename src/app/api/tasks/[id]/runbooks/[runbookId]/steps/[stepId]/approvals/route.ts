import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError, parseJsonBody } from "@/lib/api";
import { createRunbookApprovalSchema } from "@/lib/validation";
import { getOwnedTask } from "@/lib/tasks";
import { advanceTaskRunbook, recordRunbookEvent } from "@/lib/sop-engine";

type Params = { params: Promise<{ id: string; runbookId: string; stepId: string }> };
export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const userId = session.user.id;
  const { id, runbookId, stepId } = await params;
  if (!(await getOwnedTask(userId, id))) return apiError(404, "Task not found");
  const runbook = await prisma.issueRunbook.findFirst({ where: { id: runbookId, taskId: id }, include: { steps: true } });
  if (!runbook) return apiError(404, "Execution not found");
  const step = runbook.steps.find((item) => item.id === stepId);
  if (!step) return apiError(404, "Step not found");
  if (step.type !== "APPROVAL" || step.status !== "IN_PROGRESS") return apiError(409, "Approval step is not active");
  const parsed = await parseJsonBody(req, createRunbookApprovalSchema);
  if (!parsed.success) return parsed.response;
  const accepted = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "runbook_steps" WHERE "id" = ${stepId} FOR UPDATE`;
    const existing = await tx.runbookApproval.findUnique({ where: { stepId_userId: { stepId, userId } } });
    if (existing) return false;
    await tx.runbookApproval.create({ data: { stepId, userId, ...parsed.data } });
    await recordRunbookEvent(tx, runbookId, userId, "APPROVAL_RECEIVED", { stepId, decision: parsed.data.decision, comment: parsed.data.comment });
    if (parsed.data.decision === "REJECTED") {
      await tx.runbookStep.update({ where: { id: stepId }, data: { status: "FAILED", completedById: userId, completedAt: new Date(), notes: parsed.data.comment } });
      await tx.issueRunbook.update({ where: { id: runbookId }, data: { status: "FAILED", currentStepId: stepId } });
      return true;
    }
    const config = step.config && typeof step.config === "object" && !Array.isArray(step.config) ? step.config as Record<string, unknown> : {};
    const required = typeof config.requiredApprovals === "number" && Number.isInteger(config.requiredApprovals) ? Math.max(1, config.requiredApprovals) : 1;
    const approvals = await tx.runbookApproval.count({ where: { stepId, decision: "APPROVED" } });
    if (approvals >= required) {
      await tx.runbookStep.update({ where: { id: stepId }, data: { status: "VERIFIED", completedById: userId, completedAt: new Date() } });
      await recordRunbookEvent(tx, runbookId, userId, "STEP_COMPLETED", { stepId, via: "APPROVAL", approvals, required });
      await advanceTaskRunbook(tx, runbookId, id, stepId, userId);
    }
    return true;
  });
  if (!accepted) return apiError(409, "You have already submitted a decision for this step");
  const updated = await prisma.issueRunbook.findUniqueOrThrow({ where: { id: runbookId }, include: { steps: true, events: { orderBy: { createdAt: "asc" } } } });
  return NextResponse.json({ runbook: updated });
}
