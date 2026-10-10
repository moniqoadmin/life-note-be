import { NextResponse } from "next/server";
import { apiError, parseJsonBody } from "@/lib/api";
import { stepCallbackSchema } from "@/lib/validation";
import { completeStepFromCallback, engineTransaction } from "@/lib/sop/engine";
import { engineErrorResponse } from "@/lib/sop/executions";

type Params = { params: Promise<{ token: string }> };

/**
 * @swagger
 * /sop-executions/callbacks/{token}:
 *   post:
 *     tags: [SOP Executions]
 *     summary: Finish a waiting automated step (no session needed)
 *     description: >-
 *       When an external GITHUB_ACTION / AUTOMATED_ACTION step starts it gets a one-off
 *       `callbackToken` (shown on the step). CI or a script calls this URL to finish it, e.g.
 *       `curl -X POST …/api/sop-executions/callbacks/$TOKEN -d '{"status":"SUCCESS"}'`.
 *       The token stops working once the step finishes.
 *     parameters: [{ in: path, name: token, required: true, schema: { type: string } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [SUCCESS, FAILURE] }
 *               output: { type: string }
 *               executor: { type: string, example: "GitHub Actions run #812" }
 *     responses:
 *       200: { description: Accepted. }
 *       404: { description: Unknown or expired token. }
 *       409: { description: The step is no longer waiting. }
 */
export async function POST(req: Request, { params }: Params) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return apiError(404, "Unknown or expired callback");
  const parsed = await parseJsonBody(req, stepCallbackSchema);
  if (!parsed.success) return parsed.response;
  try {
    const executionId = await engineTransaction((tx) => completeStepFromCallback(tx, token, parsed.data));
    return NextResponse.json({ ok: true, executionId });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
