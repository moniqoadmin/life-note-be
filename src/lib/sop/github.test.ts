import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { extractIssueKeys, normalizeGithubEvent, verifyGithubSignature } from "@/lib/sop/github";

describe("verifyGithubSignature", () => {
  const secret = "a-very-long-webhook-secret";
  const body = JSON.stringify({ hello: "world" });
  const good = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  it("accepts the right signature and rejects everything else", () => {
    expect(verifyGithubSignature(secret, body, good)).toBe(true);
    expect(verifyGithubSignature(secret, body + " ", good)).toBe(false);
    expect(verifyGithubSignature("other-secret-value!", body, good)).toBe(false);
    expect(verifyGithubSignature(secret, body, null)).toBe(false);
    expect(verifyGithubSignature(secret, body, "sha1=abc")).toBe(false);
  });
});

describe("normalizeGithubEvent", () => {
  const repository = { full_name: "acme/payments" };

  it("maps a merged PR, its base branch and the issue keys it mentions", () => {
    const event = normalizeGithubEvent("pull_request", {
      action: "closed",
      repository,
      pull_request: { merged: true, number: 42, title: "PAY-123 fix refunds", html_url: "https://gh/pr/42", base: { ref: "main" }, head: { ref: "feature/PAY-124-x" } },
    });
    expect(event).toMatchObject({ name: "pull_request.merged", branch: "main", repository: "acme/payments", failed: false });
    expect(event?.issueKeys).toEqual(["PAY-123", "PAY-124"]);
    expect(event?.devLink).toMatchObject({ type: "PULL_REQUEST", externalId: "acme/payments#42", status: "merged" });
  });

  it("treats a failed workflow run as a failure of workflow_run.success", () => {
    const event = normalizeGithubEvent("workflow_run", {
      action: "completed",
      repository,
      workflow_run: { id: 9, name: "CI", head_branch: "PAY-123-fix", conclusion: "failure" },
    });
    expect(event).toMatchObject({ name: "workflow_run.success", failed: true, workflow: "CI", branch: "PAY-123-fix" });
  });

  it("ignores events steps don't react to", () => {
    expect(normalizeGithubEvent("pull_request", { action: "labeled", repository, pull_request: {} })).toBeNull();
    expect(normalizeGithubEvent("workflow_run", { action: "requested", repository, workflow_run: {} })).toBeNull();
    expect(normalizeGithubEvent("push", { ref: "refs/tags/v1", repository })).toBeNull();
    expect(normalizeGithubEvent("issues", {})).toBeNull();
  });

  it("extracts unique keys", () => {
    expect(extractIssueKeys("PAY-1 and PAY-1, ops-2, AB-12", null)).toEqual(["PAY-1", "AB-12"]);
  });
});
