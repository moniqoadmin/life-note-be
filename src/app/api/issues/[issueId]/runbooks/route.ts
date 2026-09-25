import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseJsonBody } from "@/lib/api";
import { attachRunbookSchema } from "@/lib/validation";
import { getAccessibleSop } from "@/lib/sops";
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
 *       Copies the SOP's current steps onto the issue as a checklist (all PENDING). Later edits to the
 *       SOP don't change this runbook; sopVersion records which version was copied. The SOP must be
 *       your own or shared into a workspace you belong to, and have at least one step.
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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { issueId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return NextResponse.json({ error: "Issue not found" }, { status: 404 });
  }

  const runbooks = await listRunbooks(issueId);
  return NextResponse.json({ runbooks });
}

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { issueId } = await params;

  if (!(await getAccessibleIssue(userId, issueId))) {
    return NextResponse.json({ error: "Issue not found" }, { status: 404 });
  }

  const parsed = await parseJsonBody(req, attachRunbookSchema);
  if (!parsed.success) return parsed.response;
  const { sopId, mode } = parsed.data;

  const sop = await getAccessibleSop(userId, sopId);
  if (!sop) {
    return NextResponse.json({ error: "SOP not found" }, { status: 404 });
  }
  const steps = await prisma.sopStep.findMany({
    where: { sopId },
    orderBy: { position: "asc" },
  });
  if (steps.length === 0) {
    return NextResponse.json({ error: "This SOP has no steps to run" }, { status: 400 });
  }

  const runbookId = await prisma.$transaction(async (tx) => {
    const runbook = await tx.issueRunbook.create({
      data: {
        issueId,
        sopId,
        sopVersion: sop.version,
        title: sop.title,
        mode,
        steps: {
          create: steps.map((s, index) => ({
            position: index,
            title: s.title,
            description: s.description,
            command: s.command,
            requiresSignoff: s.requiresSignoff,
          })),
        },
      },
    });
    await recordActivity(tx, issueId, userId, "RUNBOOK_ATTACHED", {
      runbookId: runbook.id,
      title: sop.title,
      sopVersion: sop.version,
    });
    return runbook.id;
  });

  const runbook = await getRunbook(issueId, runbookId);
  return NextResponse.json({ runbook: runbook && withRunbookProgress(runbook) }, { status: 201 });
}
