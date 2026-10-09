import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError, parseJsonBody } from "@/lib/api";
import { evaluateConditionSchema } from "@/lib/validation";
import { evaluateCondition } from "@/lib/sop-conditions";
import { buildTargetContext } from "@/lib/sop-engine";
import { getAccessibleIssue } from "@/lib/issues";
import { getOwnedTask } from "@/lib/tasks";
import { getOwnedNote } from "@/lib/notes";

/**
 * @swagger
 * /sops/conditions/evaluate:
 *   post:
 *     tags: [SOPs]
 *     summary: Test a condition
 *     description: >-
 *       Evaluates a condition without saving anything — for building and previewing step conditions and
 *       rules. The context is built from issueId or taskId (if given), with `context` merged over it, so
 *       you can try e.g. { "steps": { "qa-testing": { "result": "FAILED" } } }.
 *     security: [{ CookieAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [condition]
 *             properties:
 *               condition: { $ref: '#/components/schemas/SopCondition' }
 *               issueId: { type: string }
 *               taskId: { type: string }
 *               noteId: { type: string }
 *               context: { type: object }
 *     responses:
 *       200:
 *         description: The result and the context it was evaluated against.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 result: { type: boolean }
 *                 context: { type: object }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError(401, "Unauthorized");
  }
  const userId = session.user.id;

  const parsed = await parseJsonBody(req, evaluateConditionSchema);
  if (!parsed.success) return parsed.response;
  const { condition, issueId, taskId, noteId, context: overrides } = parsed.data;

  if (issueId && !(await getAccessibleIssue(userId, issueId))) {
    return apiError(404, "Issue not found");
  }
  if (taskId && !(await getOwnedTask(userId, taskId))) {
    return apiError(404, "Task not found");
  }
  if (noteId && !(await getOwnedNote(userId, noteId))) {
    return apiError(404, "Note not found");
  }

  const base = await buildTargetContext(prisma, { issueId, taskId, noteId });
  const context = { ...base, ...overrides };
  return NextResponse.json({ result: evaluateCondition(condition, context), context });
}
