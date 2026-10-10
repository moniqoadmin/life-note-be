import { createHmac, timingSafeEqual } from "node:crypto";
import type { DevLinkType } from "@prisma/client";

// Pure helpers for the GitHub webhook: signature check and payload normalization.

/** Verifies GitHub's `X-Hub-Signature-256` header against the raw body. */
export function verifyGithubSignature(secret: string, rawBody: string, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const ISSUE_KEY = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;

/** Issue keys (e.g. PAY-123) mentioned in branch names, titles and commit messages. */
export const extractIssueKeys = (...texts: (string | null | undefined)[]) =>
  [...new Set(texts.filter(Boolean).flatMap((t) => t!.match(ISSUE_KEY) ?? []))].slice(0, 50);

export type GithubEvent = {
  /** Matches GITHUB_ACTION step `config.event`. */
  name: "pull_request.opened" | "pull_request.merged" | "pull_request.closed" | "workflow_run.success" | "push";
  /** A failed workflow run fails steps waiting for workflow_run.success. */
  failed: boolean;
  repository: string;
  /** PR base branch, workflow head branch, or pushed branch — matched against `config.branch`. */
  branch: string | null;
  workflow: string | null;
  summary: string;
  url: string | null;
  issueKeys: string[];
  devLink: { type: DevLinkType; externalId: string; title: string; url: string | null; status: string } | null;
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const str = (v: unknown) => (typeof v === "string" ? v : null);

/** Normalizes a webhook delivery; null for events/actions SOP steps don't react to. */
export function normalizeGithubEvent(eventName: string, payload: Json): GithubEvent | null {
  const repository = str(obj(payload.repository).full_name) ?? "";
  if (eventName === "pull_request") {
    const pr = obj(payload.pull_request);
    const action = str(payload.action);
    const merged = pr.merged === true;
    const name =
      action === "opened" || action === "reopened" || action === "ready_for_review"
        ? "pull_request.opened"
        : action === "closed"
          ? merged ? "pull_request.merged" : "pull_request.closed"
          : null;
    if (!name) return null;
    const title = str(pr.title) ?? "";
    const number = typeof pr.number === "number" ? pr.number : 0;
    return {
      name,
      failed: false,
      repository,
      branch: str(obj(pr.base).ref),
      workflow: null,
      summary: `PR #${number} ${name.split(".")[1]}: ${title}`,
      url: str(pr.html_url),
      issueKeys: extractIssueKeys(title, str(obj(pr.head).ref)),
      devLink: {
        type: "PULL_REQUEST",
        externalId: `${repository}#${number}`,
        title: `#${number} ${title}`.slice(0, 300),
        url: str(pr.html_url),
        status: merged ? "merged" : action === "closed" ? "closed" : "open",
      },
    };
  }
  if (eventName === "workflow_run") {
    if (str(payload.action) !== "completed") return null;
    const runInfo = obj(payload.workflow_run);
    const conclusion = str(runInfo.conclusion) ?? "unknown";
    const workflow = str(runInfo.name);
    const branch = str(runInfo.head_branch);
    return {
      name: "workflow_run.success",
      failed: conclusion !== "success",
      repository,
      branch,
      workflow,
      summary: `Workflow "${workflow}" on ${branch}: ${conclusion}`,
      url: str(runInfo.html_url),
      issueKeys: extractIssueKeys(branch, str(runInfo.display_title), str(obj(runInfo.head_commit).message)),
      devLink: {
        type: "BUILD",
        externalId: `${repository}#run-${String(runInfo.id ?? "")}`,
        title: `${workflow ?? "Workflow"} · ${branch ?? ""}`.slice(0, 300),
        url: str(runInfo.html_url),
        status: conclusion,
      },
    };
  }
  if (eventName === "push") {
    const ref = str(payload.ref) ?? "";
    if (!ref.startsWith("refs/heads/")) return null;
    const branch = ref.slice("refs/heads/".length);
    const commits = Array.isArray(payload.commits) ? payload.commits.map((c) => str(obj(c).message)) : [];
    const head = obj(payload.head_commit);
    return {
      name: "push",
      failed: false,
      repository,
      branch,
      workflow: null,
      summary: `Pushed ${commits.length} commit(s) to ${branch}`,
      url: str(payload.compare),
      issueKeys: extractIssueKeys(branch, ...commits),
      devLink: str(head.id)
        ? {
            type: "COMMIT",
            externalId: str(head.id)!,
            title: (str(head.message) ?? "").split("\n")[0].slice(0, 300) || str(head.id)!,
            url: str(head.url),
            status: "pushed",
          }
        : null,
    };
  }
  return null;
}
