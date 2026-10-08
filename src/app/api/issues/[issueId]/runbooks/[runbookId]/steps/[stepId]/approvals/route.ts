import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError, parseJsonBody } from "@/lib/api";
import { createRunbookApprovalSchema } from "@/lib/validation";
import { getAccessibleIssue, getRunbook, withRunbookProgress } from "@/lib/issues";
import { advanceRunbook, applySopRules, recordRunbookEvent } from "@/lib/sop-engine";

type Params = { params: Promise<{ issueId: string; runbookId: string; stepId: string }> };

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const userId = session.user.id;
  const { issueId, runbookId, stepId } = await params;
  const issue = await getAccessibleIssue(userId, issueId);
  if (!issue) return apiError(404, "Issue not found");
  const runbook = await getRunbook(issueId, runbookId);
  if (!runbook) return apiError(404, "Runbook not found");
  const step = runbook.steps.find((candidate) => candidate.id === stepId);
  if (!step) return apiError(404, "Step not found");
  if (step.type !== "APPROVAL") return apiError(400, "This step does not require an approval");
  if (step.status !== "IN_PROGRESS") return apiError(409, "Approval step is not active");
  const parsed = await parseJsonBody(req, createRunbookApprovalSchema);
  if (!parsed.success) return parsed.response;

  const accepted = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "runbook_steps" WHERE "id" = ${stepId} FOR UPDATE`;
    const previous = await tx.runbookApproval.findUnique({ where: { stepId_userId: { stepId, userId } } });
    if (previous) return false;
    await tx.runbookApproval.create({ data: { stepId, userId, ...parsed.data } });
    await recordRunbookEvent(tx, runbookId, userId, "APPROVAL_RECEIVED", {
      stepId, decision: parsed.data.decision, comment: parsed.data.comment,
    });
    if (parsed.data.decision === "REJECTED") {
      await tx.runbookStep.update({ where: { id: stepId }, data: { status: "FAILED", completedById: userId, completedAt: new Date(), notes: parsed.data.comment } });
      await tx.issueRunbook.update({ where: { id: runbookId }, data: { status: "FAILED", currentStepId: stepId } });
      await applySopRules(tx, runbookId, issueId, "STEP_FAILED", userId);
      return true;
    }

    const config = step.config && typeof step.config === "object" && !Array.isArray(step.config)
      ? step.config as Record<string, unknown> : {};
    const required = typeof config.requiredApprovals === "number" && Number.isInteger(config.requiredApprovals)
      ? Math.max(1, config.requiredApprovals) : 1;
    const approvals = await tx.runbookApproval.count({ where: { stepId, decision: "APPROVED" } });
    if (approvals >= required) {
      await tx.runbookStep.update({ where: { id: stepId }, data: { status: "VERIFIED", completedById: userId, completedAt: new Date() } });
      await recordRunbookEvent(tx, runbookId, userId, "STEP_COMPLETED", { stepId, via: "APPROVAL", approvals, required });
      await advanceRunbook(tx, runbookId, issueId, stepId, userId);
      await applySopRules(tx, runbookId, issueId, "STEP_COMPLETED", userId);
    }
    return true;
  });
  if (!accepted) return apiError(409, "You have already submitted a decision for this step");

  const updated = await getRunbook(issueId, runbookId);
  return NextResponse.json({ runbook: updated && withRunbookProgress(updated) });
}
