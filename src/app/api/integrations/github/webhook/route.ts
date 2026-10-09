import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api";
import { env } from "@/lib/env";
import { ENGINE_TX_OPTIONS, OPEN_EXECUTION_STATUSES, handleExternalEvent, type ExternalEvent } from "@/lib/sop-engine";

// Matches issue keys like PAY-123 in branch names ("pay-123-fix-refunds" is upper-cased first) and titles.
const ISSUE_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;

function verifySignature(secret: string, body: string, header: string | null) {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

type PullRequestPayload = {
  action: string;
  repository: { full_name: string };
  pull_request: {
    number: number;
    title: string;
    html_url: string;
    merged: boolean;
    head: { ref: string };
    base: { ref: string };
  };
};

type CheckSuitePayload = {
  action: string;
  repository: { full_name: string };
  check_suite: {
    conclusion: string | null;
    head_branch: string | null;
    pull_requests: { base: { ref: string } }[];
  };
};

type Parsed = {
  repo: string;
  texts: string[];
  event: ExternalEvent | null;
  pr?: { number: number; title: string; url: string; status: string };
};

function parse(eventName: string | null, payload: unknown): Parsed | null {
  if (eventName === "pull_request") {
    const { action, repository, pull_request: pr } = payload as PullRequestPayload;
    const type =
      action === "opened" || action === "reopened" ? "PR_OPENED" : action === "closed" && pr.merged ? "PR_MERGED" : null;
    return {
      repo: repository.full_name,
      texts: [pr.head.ref, pr.title],
      event: type && { source: "github", type, baseBranch: pr.base.ref, url: pr.html_url, title: pr.title },
      pr: {
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        status: pr.merged ? "merged" : action === "closed" ? "closed" : "open",
      },
    };
  }
  if (eventName === "check_suite") {
    const { action, repository, check_suite: suite } = payload as CheckSuitePayload;
    const passed = action === "completed" && suite.conclusion === "success";
    return {
      repo: repository.full_name,
      texts: suite.head_branch ? [suite.head_branch] : [],
      event: passed
        ? { source: "github", type: "CHECKS_PASSED", baseBranch: suite.pull_requests[0]?.base.ref ?? null }
        : null,
    };
  }
  return null;
}

/**
 * @swagger
 * /integrations/github/webhook:
 *   post:
 *     tags: [Runbooks]
 *     summary: GitHub webhook
 *     description: >-
 *       Point a GitHub repo webhook (content type application/json, events "Pull requests" and "Check
 *       suites") here, with the secret in GITHUB_WEBHOOK_SECRET, and set the project's githubRepo to
 *       "owner/repo". Issues are matched by key in the PR's head branch or title. PRs are recorded as
 *       dev links, and an active GITHUB_ACTION step whose config.event (PR_OPENED / PR_MERGED /
 *       CHECKS_PASSED) and optional config.baseBranch match is completed.
 *     parameters:
 *       - { in: header, name: X-GitHub-Event, required: true, schema: { type: string } }
 *       - { in: header, name: X-Hub-Signature-256, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Processed (or ignored).
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
export async function POST(req: Request) {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return apiError(503, "GitHub integration is not configured", { code: "NOT_CONFIGURED" });
  }
  const body = await req.text();
  if (!verifySignature(secret, body, req.headers.get("x-hub-signature-256"))) {
    return apiError(401, "Invalid signature");
  }

  const eventName = req.headers.get("x-github-event");
  if (eventName === "ping") return NextResponse.json({ ok: true });

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return apiError(400, "Invalid JSON");
  }
  const parsed = parse(eventName, payload);
  if (!parsed) return NextResponse.json({ ok: true, ignored: true });

  const keys = [...new Set(parsed.texts.flatMap((t) => [...t.toUpperCase().matchAll(ISSUE_KEY)].map((m) => m[1])))];
  if (!keys.length) return NextResponse.json({ ok: true, issues: 0 });

  const issues = await prisma.issue.findMany({
    where: { key: { in: keys }, project: { githubRepo: parsed.repo.toLowerCase() } },
    select: { id: true },
  });

  let completedSteps = 0;
  for (const issue of issues) {
    await prisma.$transaction(async (tx) => {
      if (parsed.pr) {
        const externalId = `${parsed.repo}#${parsed.pr.number}`;
        const link = await tx.devLink.findFirst({ where: { issueId: issue.id, type: "PULL_REQUEST", externalId } });
        const data = { title: parsed.pr.title, url: parsed.pr.url, status: parsed.pr.status };
        if (link) await tx.devLink.update({ where: { id: link.id }, data });
        else await tx.devLink.create({ data: { issueId: issue.id, type: "PULL_REQUEST", externalId, ...data } });
      }
      if (!parsed.event) return;
      const executions = await tx.issueRunbook.findMany({
        where: { issueId: issue.id, status: { in: OPEN_EXECUTION_STATUSES } },
        select: { id: true },
      });
      for (const { id } of executions) {
        if (await handleExternalEvent(tx, id, parsed.event)) completedSteps++;
      }
    }, ENGINE_TX_OPTIONS);
  }

  return NextResponse.json({ ok: true, issues: issues.length, completedSteps });
}
