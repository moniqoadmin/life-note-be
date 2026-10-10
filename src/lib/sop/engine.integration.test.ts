import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";

// End-to-end engine test against a real Postgres. Opt-in: set SOP_TEST_DATABASE_URL to a
// *disposable* local database that has the schema applied (prisma db push / migrations).
// It refuses to run against anything that isn't localhost.
const url = process.env.SOP_TEST_DATABASE_URL;
const isLocal = !!url && /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);

describe.skipIf(!isLocal)("SOP engine (integration)", () => {
  let prisma: PrismaClient;
  let engine: typeof import("@/lib/sop/engine");
  let definition: typeof import("@/lib/sop/definition");
  const id = (s: string) => `t_${s}_${Math.random().toString(36).slice(2, 8)}`;
  const userId = id("u1");
  const otherUserId = id("u2");
  const releaseSopId = id("sop");
  const hotfixSopId = id("hotfix");
  const moduleId = id("module");
  const otherModuleId = id("module2");

  const tx = <T>(fn: (db: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(fn, { timeout: 30_000 });
  const load = (executionId: string) =>
    prisma.issueRunbook.findUniqueOrThrow({
      where: { id: executionId },
      include: { steps: { orderBy: { position: "asc" } }, events: { orderBy: { createdAt: "asc" } } },
    });
  const stepByKey = async (executionId: string, key: string) => (await load(executionId)).steps.find((s) => s.key === key)!;
  const current = async (executionId: string) => {
    const e = await load(executionId);
    return e.steps.find((s) => s.id === e.currentStepId)?.key ?? null;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    ({ prisma } = await import("@/lib/prisma"));
    engine = await import("@/lib/sop/engine");
    definition = await import("@/lib/sop/definition");

    await prisma.user.createMany({ data: [{ id: userId, email: `${userId}@t.io` }, { id: otherUserId, email: `${otherUserId}@t.io` }] });
    await prisma.sop.create({
      data: {
        id: releaseSopId, userId, title: "Backend Production Release",
        steps: {
          create: [
            { key: "development", position: 0, title: "Development Complete", type: "USER_ACTION" },
            {
              key: "dev_checklist", position: 1, title: "Developer Checklist", type: "CHECKLIST",
              config: { items: [{ key: "tests", label: "Tests written", required: true }, { key: "docs", label: "Docs", required: false }] },
            },
            {
              key: "tech_lead", position: 2, title: "Tech Lead Approval", type: "APPROVAL",
              config: {
                requiredApprovals: 1,
                overrides: [{ when: { field: "fields.riskLevel", operator: "EQUALS", value: "HIGH" }, set: { requiredApprovals: 2 } }],
              },
            },
            {
              key: "regression", position: 3, title: "Regression Testing", type: "TESTING",
              condition: { field: "issue.labels", operator: "CONTAINS", value: "bug" },
            },
            { key: "qa", position: 4, title: "QA Testing", type: "TESTING" },
            { key: "gate", position: 5, title: "QA gate", type: "CONDITION", config: { check: { field: "steps.qa.result", operator: "EQUALS", value: "PASSED" } } },
            { key: "to_review", position: 6, title: "Move to review", type: "AUTOMATED_ACTION", config: { action: { type: "SET_SUBJECT_STATUS", status: "IN_REVIEW" } } },
            { key: "deploy", position: 7, title: "Deployment Confirmation", type: "GITHUB_ACTION", config: {} },
          ],
        },
        rules: {
          create: [{
            name: "QA failed → back to development",
            trigger: "STEP_FAILED",
            condition: { field: "trigger.stepKey", operator: "EQUALS", value: "qa" },
            action: [{ type: "GOTO_STEP", stepKey: "development" }, { type: "ADD_LABEL", label: "qa-failed" }],
          }],
        },
      },
    });
    await prisma.sop.create({
      data: { id: hotfixSopId, userId, title: "Hotfix", steps: { create: [{ key: "fix", position: 0, title: "Fix it" }] } },
    });
    // Publish v1 of the release SOP the same way POST /sops/{id}/publish does.
    const sop = await prisma.sop.findUniqueOrThrow({ where: { id: releaseSopId }, include: { steps: true, rules: true } });
    const def = definition.buildDefinition(sop, sop.steps, sop.rules);
    expect(definition.validateDefinition(def)).toEqual([]);
    await prisma.sopVersion.create({ data: { sopId: releaseSopId, version: 1, definition: def as unknown as Prisma.InputJsonObject } });
    await prisma.sop.update({ where: { id: releaseSopId }, data: { publishedVersion: 1 } });

    // @payment-service module: tickets (depth ≥ 1 below it) inherit the release SOP.
    await prisma.note.createMany({
      data: [
        { id: moduleId, userId, title: "payment-service" },
        { id: otherModuleId, userId, title: "web-app" },
      ],
    });
    await prisma.sopAssignment.create({
      data: { noteId: moduleId, sopId: releaseSopId, condition: { field: "note.depth", operator: "GREATER_THAN_OR_EQUAL", value: 1 } },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.note.deleteMany({ where: { userId } });
    await prisma.sop.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  });

  it("runs the Backend Production Release end to end", async () => {
    const ticketId = id("ticket");
    await prisma.note.create({ data: { id: ticketId, userId, parentId: moduleId, title: "PAY-123", customFields: { riskLevel: "HIGH" } } });

    // Task created under the entity → inherits its SOP and starts the first step.
    const { executionId } = await tx((db) => engine.syncAssignedExecution(db, { type: "NOTE", id: ticketId }, userId));
    expect(executionId).toBeTruthy();
    const exec = executionId!;
    let e = await load(exec);
    expect(e.assignmentType).toBe("ENTITY_INHERITED");
    expect(e.status).toBe("IN_PROGRESS");
    expect(await current(exec)).toBe("development");
    expect(e.events[0].data).toMatchObject({ published: true, source: { kind: "ASSIGNMENT", scopeId: moduleId } });

    const step = (key: string) => stepByKey(exec, key).then((s) => s.id);
    const update = async (key: string, patch: Parameters<typeof engine.updateStep>[4], actor = userId) =>
      tx(async (db) => engine.updateStep(db, exec, await step(key), actor, patch));

    // Only the active step can be finished.
    await expect(update("qa", { result: "PASSED" })).rejects.toMatchObject({ status: 409 });
    await update("development", { status: "VERIFIED" });
    expect(await current(exec)).toBe("dev_checklist");

    // Checklist needs its required items.
    await expect(update("dev_checklist", { status: "VERIFIED" })).rejects.toMatchObject({ status: 400 });
    await update("dev_checklist", { checklist: { tests: true } });
    await update("dev_checklist", { status: "VERIFIED" });

    // High risk → the approval step resolved to 2 required approvals.
    const approval = await stepByKey(exec, "tech_lead");
    expect((approval.config as { requiredApprovals: number }).requiredApprovals).toBe(2);
    await tx(async (db) => engine.submitApproval(db, exec, approval.id, userId, { decision: "APPROVED", comment: "" }));
    expect(await current(exec)).toBe("tech_lead");
    await expect(
      tx(async (db) => engine.submitApproval(db, exec, approval.id, userId, { decision: "APPROVED", comment: "" }))
    ).rejects.toMatchObject({ status: 409 });
    await tx(async (db) => engine.submitApproval(db, exec, approval.id, otherUserId, { decision: "APPROVED", comment: "" }));

    // No "bug" label → regression skipped when reached; QA is next.
    expect((await stepByKey(exec, "regression")).status).toBe("SKIPPED");
    expect(await current(exec)).toBe("qa");

    // QA fails → rule sends the task back to development and labels it.
    await update("qa", { result: "FAILED" });
    e = await load(exec);
    expect(e.status).toBe("IN_PROGRESS");
    expect(await current(exec)).toBe("development");
    expect(e.steps.filter((s) => s.position >= 0).every((s) => s.key === "development" ? s.status === "IN_PROGRESS" : s.status === "PENDING")).toBe(true);
    expect(await prisma.runbookApproval.count({ where: { stepId: approval.id } })).toBe(0);
    let note = await prisma.note.findUniqueOrThrow({ where: { id: ticketId } });
    expect(note.labels).toContain("qa-failed");
    expect(e.events.map((ev) => ev.type)).toEqual(expect.arrayContaining(["STEP_FAILED", "RULE_EXECUTED", "EXECUTION_REWOUND"]));

    // Second pass. The "bug" label added now makes regression apply (conditions are lazy).
    await prisma.note.update({ where: { id: ticketId }, data: { labels: ["qa-failed", "bug"] } });
    await update("development", { status: "VERIFIED" });
    await update("dev_checklist", { checklist: { tests: true } });
    await update("dev_checklist", { status: "VERIFIED" });
    for (const approver of [userId, otherUserId]) {
      await tx(async (db) => engine.submitApproval(db, exec, approval.id, approver, { decision: "APPROVED", comment: "" }));
    }
    expect(await current(exec)).toBe("regression");
    await update("regression", { result: "PASSED" });
    await update("qa", { result: "PASSED" });

    // Gate passes, automated step moves the note to review, deploy waits for a callback.
    expect((await stepByKey(exec, "gate")).result).toBe("TRUE");
    note = await prisma.note.findUniqueOrThrow({ where: { id: ticketId } });
    expect(note.status).toBe("IN_REVIEW");
    const deploy = await stepByKey(exec, "deploy");
    expect(deploy.status).toBe("IN_PROGRESS");
    expect(deploy.callbackToken).toBeTruthy();

    await tx((db) => engine.completeStepFromCallback(db, deploy.callbackToken!, { status: "SUCCESS", executor: "CI #812" }));
    e = await load(exec);
    expect(e.status).toBe("COMPLETED");
    expect(e.completedAt).not.toBeNull();
    expect((await stepByKey(exec, "deploy")).callbackToken).toBeNull();
    await expect(
      tx((db) => engine.completeStepFromCallback(db, deploy.callbackToken!, { status: "SUCCESS" }))
    ).rejects.toMatchObject({ status: 404 });

    // Rewinding a finished run reopens it at that step.
    await update("qa", { status: "IN_PROGRESS" });
    expect((await load(exec)).status).toBe("IN_PROGRESS");
    expect(await current(exec)).toBe("qa");
  });

  it("serializes concurrent completions of the same step", async () => {
    const ticketId = id("ticket");
    await prisma.note.create({ data: { id: ticketId, userId, parentId: moduleId, title: "PAY-124" } });
    const { executionId } = await tx((db) => engine.syncAssignedExecution(db, { type: "NOTE", id: ticketId }, userId));
    const dev = await stepByKey(executionId!, "development");
    // The loser waits on the row lock, then sees the step already VERIFIED (an idempotent
    // no-op). Either way the run must advance exactly once.
    await Promise.allSettled(
      [userId, otherUserId, userId].map((actor) => tx((db) => engine.updateStep(db, executionId!, dev.id, actor, { status: "VERIFIED" })))
    );
    expect(await current(executionId!)).toBe("dev_checklist");
    const events = (await load(executionId!)).events;
    expect(events.filter((ev) => ev.type === "STEP_COMPLETED")).toHaveLength(1);
    expect(events.filter((ev) => ev.type === "STEP_STARTED")).toHaveLength(2);

    // Two different transitions racing: one wins, the other is rejected as out of date.
    const checklist = await stepByKey(executionId!, "dev_checklist");
    await tx((db) => engine.updateStep(db, executionId!, checklist.id, userId, { checklist: { tests: true } }));
    const raced = await Promise.allSettled([
      tx((db) => engine.updateStep(db, executionId!, checklist.id, userId, { status: "VERIFIED" })),
      tx((db) => engine.updateStep(db, executionId!, checklist.id, otherUserId, { status: "BLOCKED" })),
    ]);
    expect(raced.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(raced.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("keeps a matching run, swaps on override, and respects assignment conditions", async () => {
    const ticketId = id("ticket");
    await prisma.note.create({ data: { id: ticketId, userId, parentId: moduleId, title: "PAY-125" } });
    const subject = { type: "NOTE", id: ticketId } as const;
    const first = await tx((db) => engine.syncAssignedExecution(db, subject, userId));
    await tx(async (db) => engine.updateStep(db, first.executionId!, (await stepByKey(first.executionId!, "development")).id, userId, { status: "VERIFIED" }));

    // Re-resolving with nothing changed keeps the run and its progress.
    const again = await tx((db) => engine.syncAssignedExecution(db, subject, userId));
    expect(again).toEqual({ executionId: first.executionId, changed: false });
    expect(await current(first.executionId!)).toBe("dev_checklist");

    // Task-level override wins over the entity default; the old run is cancelled, not deleted.
    await prisma.note.update({ where: { id: ticketId }, data: { sopOverrideId: hotfixSopId } });
    const overridden = await tx((db) => engine.syncAssignedExecution(db, subject, userId));
    expect(overridden.changed).toBe(true);
    expect((await load(first.executionId!)).status).toBe("SKIPPED");
    const hotfix = await load(overridden.executionId!);
    expect(hotfix.assignmentType).toBe("TASK_OVERRIDE");
    expect(hotfix.sopVersion).toBe(1); // never published → runs the draft

    // A note under a module without assignments resolves to nothing.
    const loose = id("loose");
    await prisma.note.create({ data: { id: loose, userId, parentId: otherModuleId, title: "other" } });
    expect(await tx((db) => engine.syncAssignedExecution(db, { type: "NOTE", id: loose }, userId))).toEqual({ executionId: null, changed: false });

    // The module itself (depth 0) doesn't match its own "depth ≥ 1" assignment.
    expect(await tx((db) => engine.resolveSubjectSop(db, { type: "NOTE", id: moduleId }))).toBeNull();
  });

  it("stops runaway rules instead of looping forever", async () => {
    const loopSopId = id("loop");
    await prisma.sop.create({
      data: {
        id: loopSopId, userId, title: "Loop",
        steps: { create: [{ key: "a", position: 0, title: "A" }] },
        rules: { create: [{ name: "restart a", trigger: "STEP_STARTED", condition: { field: "trigger.stepKey", operator: "EQUALS", value: "a" }, action: [{ type: "GOTO_STEP", stepKey: "a" }] }] },
      },
    });
    const ticketId = id("ticket");
    await prisma.note.create({ data: { id: ticketId, userId, title: "loop" } });
    const executionId = await tx((db) => engine.attachExecution(db, { type: "NOTE", id: ticketId }, loopSopId, userId));
    const e = await load(executionId);
    expect(e.events.some((ev) => ev.type === "RULES_SKIPPED")).toBe(true);
    expect(e.steps[0].status).toBe("IN_PROGRESS");
  });
});
