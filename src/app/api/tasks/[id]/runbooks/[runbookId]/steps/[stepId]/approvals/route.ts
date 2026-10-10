import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError, parseJsonBody } from "@/lib/api";
import { createRunbookApprovalSchema } from "@/lib/validation";
import { getOwnedTask } from "@/lib/tasks";
import { engineTransaction, submitApproval } from "@/lib/sop/engine";
import { engineErrorResponse, getExecution } from "@/lib/sop/executions";

type Params = { params: Promise<{ id: string; runbookId: string; stepId: string }> };

// Same contract as POST /sop-executions/{executionId}/steps/{stepId}/approvals, scoped to a task.
export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return apiError(401, "Unauthorized");
  const userId = session.user.id;
  const { id, runbookId, stepId } = await params;
  if (!(await getOwnedTask(userId, id))) return apiError(404, "Task not found");
  if (!(await prisma.issueRunbook.findFirst({ where: { id: runbookId, taskId: id }, select: { id: true } }))) {
    return apiError(404, "Execution not found");
  }
  const parsed = await parseJsonBody(req, createRunbookApprovalSchema);
  if (!parsed.success) return parsed.response;

  try {
    await engineTransaction((tx) => submitApproval(tx, runbookId, stepId, userId, parsed.data));
  } catch (error) {
    return engineErrorResponse(error);
  }
  return NextResponse.json({ runbook: await getExecution(runbookId) });
}
