import { describe, expect, it } from "vitest";
import { normalizeActions, snapshotOf, validateDefinition, type SopDefinition } from "@/lib/sop/definition";

const step = (key: string, position: number, type: SopDefinition["steps"][number]["type"] = "INSTRUCTION", config = {}, condition: unknown = null) => ({
  key, position, title: key, description: "", command: null, requiresSignoff: false, type, config, condition,
});

const releaseSop: SopDefinition = {
  sopId: "sop1",
  title: "Backend Production Release",
  version: 3,
  steps: [
    step("development", 0),
    step("checklist", 1, "CHECKLIST", { items: [{ key: "tests", label: "Unit tests written", required: true }] }),
    step("tech_lead", 2, "APPROVAL", {
      requiredApprovals: 1,
      overrides: [{ when: { field: "fields.riskLevel", operator: "EQUALS", value: "HIGH" }, set: { requiredApprovals: 2 } }],
    }),
    step("regression", 3, "TESTING", {}, { field: "issue.type", operator: "EQUALS", value: "BUG" }),
    step("qa_testing", 4, "TESTING"),
    step("merge_prod", 5, "GITHUB_ACTION", { event: "pull_request.merged", branch: "main" }),
  ],
  rules: [
    {
      id: "r1",
      name: "QA failed → back to development",
      trigger: "STEP_FAILED",
      condition: { field: "trigger.stepKey", operator: "EQUALS", value: "qa_testing" },
      actions: [{ type: "GOTO_STEP", stepKey: "development" }, { type: "SET_SUBJECT_STATUS", status: "IN_PROGRESS" }],
      enabled: true,
    },
  ],
};

describe("validateDefinition", () => {
  it("accepts a well-formed SOP", () => {
    expect(validateDefinition(releaseSop)).toEqual([]);
  });

  it("flags unknown step references in rules, conditions and branches", () => {
    const broken: SopDefinition = {
      ...releaseSop,
      steps: [
        ...releaseSop.steps,
        step("gate", 6, "CONDITION", { check: { field: "steps.nope.status", operator: "EQUALS", value: "VERIFIED" }, onFalseGoto: "missing" }),
      ],
      rules: [{ ...releaseSop.rules[0], actions: [{ type: "GOTO_STEP", stepKey: "ghost" }] }],
    };
    const problems = validateDefinition(broken);
    expect(problems.some((p) => p.includes('"nope"'))).toBe(true);
    expect(problems.some((p) => p.includes('"missing"'))).toBe(true);
    expect(problems.some((p) => p.includes('"ghost"'))).toBe(true);
  });

  it("validates per-type config", () => {
    const problems = validateDefinition({ ...releaseSop, steps: [step("list", 0, "CHECKLIST", { items: [] })], rules: [] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/checklist needs at least one item/i);
  });

  it("requires at least one step", () => {
    expect(validateDefinition({ ...releaseSop, steps: [], rules: [] })).toContain("An SOP needs at least one step");
  });
});

describe("legacy snapshots", () => {
  it("normalizes a single pre-v2 action and trigger", () => {
    expect(normalizeActions({ type: "SET_ISSUE_STATUS", status: "TODO" })).toEqual([{ type: "SET_ISSUE_STATUS", status: "TODO" }]);
    expect(normalizeActions([{ type: "NOPE" }])).toEqual([]);
    const snap = snapshotOf({
      id: "s", title: "Old", version: 1,
      steps: [{ id: "x", position: 0, title: "A", type: "INSTRUCTION", config: {} }],
      rules: [{ id: "r", name: "n", trigger: "ISSUE_STATUS_CHANGED", condition: null, action: { type: "SET_RUNBOOK_STATUS", status: "BLOCKED" }, enabled: true }],
    });
    expect(snap.steps[0].key).toBe("step_1");
    expect(snap.rules[0].trigger).toBe("SUBJECT_STATUS_CHANGED");
    expect(snap.rules[0].actions).toHaveLength(1);
  });
});
