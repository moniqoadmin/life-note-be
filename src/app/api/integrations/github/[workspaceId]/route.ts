import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { apiError } from "@/lib/api";
import { recordActivity } from "@/lib/issues";
import { normalizeGithubEvent, verifyGithubSignature } from "@/lib/sop/github";
import { ENGINE_TX, handleGithubEvent } from "@/lib/sop/engine";

type Params = { params: Promise<{ workspaceId: string }> };

/**
 * @swagger
 * /integrations/github/{workspaceId}:
 *   post:
 *     tags: [Integrations]
 *     summary: GitHub webhook (drives GITHUB_ACTION SOP steps)
 *     description: >-
 *       Configure a GitHub webhook (JSON; pull requests, workflow runs, pushes) with
 *       GITHUB_WEBHOOK_SECRET. Issue keys (e.g. PAY-123) in the PR title / branch / commit
 *       messages link the delivery to issues in this workspace: a dev link is recorded, and an
 *       active GITHUB_ACTION step whose config matches (`event`, optional `repository`, `branch`,
 *       `workflow`) completes — or fails, for a failed workflow run. Signature-checked; no session.
 *     parameters: [{ in: path, name: workspaceId, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: "{ issues, steps } — how many issues matched and steps moved." }
 *       401: { description: Bad signature. }
 *       503: { description: GITHUB_WEBHOOK_SECRET isn't configured. }
 */
export async function POST(req: Request, { params }: Params) {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return apiError(503, "GitHub integration isn't configured", { code: "NOT_CONFIGURED" });

  const rawBody = await req.text();
  if (!verifyGithubSignature(secret, rawBody, req.headers.get("x-hub-signature-256"))) {
    return apiError(401, "Invalid signature");
  }
  const eventName = req.headers.get("x-github-event") ?? "";
  if (eventName === "ping") return NextResponse.json({ ok: true });

  const { workspaceId } = await params;
  if (!(await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } }))) {
    return apiError(404, "Workspace not found");
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return apiError(400, "Body must be JSON");
  }
  const event = normalizeGithubEvent(eventName, payload);
  if (!event || event.issueKeys.length === 0) return NextResponse.json({ issues: 0, steps: 0 });

  const issues = await prisma.issue.findMany({
    where: { workspaceId, key: { in: event.issueKeys } },
    select: { id: true },
  });
  let steps = 0;
  for (const issue of issues) {
    steps += await prisma.$transaction(async (tx) => {
      if (event.devLink) {
        const { type, externalId, title, url, status } = event.devLink;
        const existing = await tx.devLink.findFirst({ where: { issueId: issue.id, type, externalId } });
        if (existing) {
          await tx.devLink.update({ where: { id: existing.id }, data: { title, url, status } });
        } else {
          await tx.devLink.create({ data: { issueId: issue.id, type, externalId, title, url, status } });
          await recordActivity(tx, issue.id, null, "DEV_LINK_ADDED", { type, title, source: "github" });
        }
      }
      return handleGithubEvent(tx, issue.id, event);
    }, ENGINE_TX);
  }
  return NextResponse.json({ issues: issues.length, steps });
}
