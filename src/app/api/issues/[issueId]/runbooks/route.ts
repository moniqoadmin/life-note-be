import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { parseJsonBody, apiError } from "@/lib/api";
import { attachRunbookSchema } from "@/lib/validation";
import { attachExecution, engineTransaction } from "@/lib/sop/engine";
import { engineErrorResponse } from "@/lib/sop/executions";
import {
  getAccessibleIssue,
  getRunbook,
  listRunbooks,
  recordActivity,
  withRunbookProgress,
} from "@/lib/issues";

type Params = { params: Promise<{ issueId: string }> };

/**
 * @swagger
 * /issues/{issueId}/runbooks:
 *   get:
 *     tags: [Runbooks]
 *     summary: List an issue's runbooks
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/IssueId' }]
 *     responses:
 *       200:
 *         description: Runbooks with their steps and progress.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 runbooks: { type: array, items: { $ref: '#/components/schemas/Runbook' } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   post:
 *     tags: [Runbooks]
 *     summary: Attach an SOP as a runbook
 *     description: >-
 *       Starts an SOP execution on the issue (assignmentType MANUAL) from the SOP's latest published
 *       version, or its draft if it was never published. Later edits to the SOP don't change this
 *       runbook; sopVersion records which version was copied. The SOP must be shared into the
 *       issue's workspace or be your own private SOP, and have at least one step. The first
 *       applicable step starts immediately.
 *     security: [{ CookieAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/IssueId' }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sopId]
 *             properties:
 *               sopId: { type: string }
 *               mode: { type: string, enum: [MANUAL, AUTOMATED], default: MANUAL }
 *     responses:
 *       201:
 *         description: The runbook.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 runbook: { $ref: '#/components/schemas/Runbook' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { issueId } = await params;

  const issue = await getAccessibleIssue(userId, issueId);
  if (!issue) {
    return apiError(404, "Issue not found");
  }

  const runbooks = await listRunbooks(issueId);
  return NextResponse.json({ runbooks });
}

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;
  const { issueId } = await params;

  const issue = await getAccessibleIssue(userId, issueId);
  if (!issue) {
    return apiError(404, "Issue not found");
  }

  const parsed = await parseJsonBody(req, attachRunbookSchema);
  if (!parsed.success) return parsed.response;
  const { sopId, mode } = parsed.data;

  let runbookId: string;
  try {
    runbookId = await engineTransaction(async (tx) => {
      const id = await attachExecution(tx, { type: "ISSUE", id: issueId }, sopId, userId, mode);
      await recordActivity(tx, issueId, userId, "RUNBOOK_ATTACHED", { runbookId: id, assignmentType: "MANUAL" });
      return id;
    });
  } catch (error) {
    return engineErrorResponse(error);
  }

  const runbook = await getRunbook(issueId, runbookId);
  return NextResponse.json({ runbook: runbook && withRunbookProgress(runbook) }, { status: 201 });
}
