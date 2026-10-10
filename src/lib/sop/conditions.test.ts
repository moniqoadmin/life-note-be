import { describe, expect, it } from "vitest";
import { evaluateCondition, readPath, resolveStepConfig, slugifyKey } from "@/lib/sop/conditions";

const context = {
  issue: { type: "BUG", status: "IN_PROGRESS", priority: "HIGH", labels: ["payments", "Hotfix"], storyPoints: 5, title: "Refund fails" },
  entity: { kind: "MODULE", name: "payment-service" },
  fields: { riskLevel: "HIGH", amount: "1200", dueOn: "2026-10-20" },
  steps: { qa_testing: { status: "FAILED", result: "FAILED", approvals: 0 }, review: { status: "VERIFIED", approvals: 2 } },
  trigger: { type: "STEP_FAILED", stepKey: "qa_testing" },
};

describe("evaluateCondition", () => {
  it("treats a missing condition as always true", () => {
    expect(evaluateCondition(null, context)).toBe(true);
    expect(evaluateCondition(undefined, context)).toBe(true);
  });

  it("covers the spec's example rules", () => {
    // IF Ticket Type = BUG
    expect(evaluateCondition({ field: "issue.type", operator: "EQUALS", value: "BUG" }, context)).toBe(true);
    // IF Risk Level = HIGH
    expect(evaluateCondition({ field: "fields.riskLevel", operator: "EQUALS", value: "HIGH" }, context)).toBe(true);
    // IF Entity = PAYMENT
    expect(evaluateCondition({ field: "entity.name", operator: "CONTAINS", value: "payment" }, context)).toBe(true);
    // IF QA Result = FAILED
    expect(
      evaluateCondition(
        { all: [{ field: "trigger.stepKey", operator: "EQUALS", value: "qa_testing" }, { field: "steps.qa_testing.result", operator: "EQUALS", value: "FAILED" }] },
        context
      )
    ).toBe(true);
  });

  it("compares strings case-insensitively", () => {
    expect(evaluateCondition({ field: "issue.type", operator: "EQUALS", value: "bug" }, context)).toBe(true);
    expect(evaluateCondition({ field: "issue.labels", operator: "CONTAINS", value: "hotfix" }, context)).toBe(true);
    expect(evaluateCondition({ field: "issue.labels", operator: "NOT_CONTAINS", value: "frontend" }, context)).toBe(true);
  });

  it("supports IN / NOT_IN on scalars and lists", () => {
    expect(evaluateCondition({ field: "issue.priority", operator: "IN", value: ["URGENT", "HIGH"] }, context)).toBe(true);
    expect(evaluateCondition({ field: "issue.priority", operator: "NOT_IN", value: ["LOW"] }, context)).toBe(true);
    expect(evaluateCondition({ field: "issue.labels", operator: "IN", value: ["payments"] }, context)).toBe(true);
    expect(evaluateCondition({ field: "issue.labels", operator: "NOT_IN", value: ["payments"] }, context)).toBe(false);
    expect(evaluateCondition({ field: "issue.priority", operator: "IN", value: "HIGH" }, context)).toBe(false);
  });

  it("compares numbers, numeric strings and ISO dates", () => {
    expect(evaluateCondition({ field: "issue.storyPoints", operator: "GREATER_THAN", value: 3 }, context)).toBe(true);
    expect(evaluateCondition({ field: "issue.storyPoints", operator: "LESS_THAN_OR_EQUAL", value: 5 }, context)).toBe(true);
    expect(evaluateCondition({ field: "fields.amount", operator: "GREATER_THAN", value: 999 }, context)).toBe(true);
    // "5" vs "10" must compare as numbers, not as dates or strings.
    expect(evaluateCondition({ field: "fields.amount", operator: "LESS_THAN", value: "10" }, { fields: { amount: "5" } })).toBe(true);
    expect(evaluateCondition({ field: "fields.dueOn", operator: "LESS_THAN", value: "2026-11-01" }, context)).toBe(true);
    expect(evaluateCondition({ field: "issue.title", operator: "GREATER_THAN", value: 1 }, context)).toBe(false);
  });

  it("handles EXISTS / NOT_EXISTS including empty values", () => {
    expect(evaluateCondition({ field: "fields.riskLevel", operator: "EXISTS" }, context)).toBe(true);
    expect(evaluateCondition({ field: "fields.missing", operator: "NOT_EXISTS" }, context)).toBe(true);
    expect(evaluateCondition({ field: "issue.labels", operator: "EXISTS" }, { issue: { labels: [] } })).toBe(false);
  });

  it("combines with all / any / not", () => {
    const highRiskBug = {
      all: [
        { field: "issue.type", operator: "EQUALS", value: "BUG" },
        { any: [{ field: "fields.riskLevel", operator: "EQUALS", value: "HIGH" }, { field: "issue.priority", operator: "EQUALS", value: "URGENT" }] },
        { not: { field: "issue.status", operator: "EQUALS", value: "DONE" } },
      ],
    };
    expect(evaluateCondition(highRiskBug, context)).toBe(true);
    expect(evaluateCondition({ not: highRiskBug }, context)).toBe(false);
  });

  it("rejects malformed nodes, unknown roots and prototype paths", () => {
    expect(evaluateCondition({}, context)).toBe(false);
    expect(evaluateCondition([], context)).toBe(false);
    expect(evaluateCondition({ field: "secret.value", operator: "EXISTS" }, context)).toBe(false);
    expect(evaluateCondition({ field: "issue.type", operator: "MATCHES", value: ".*" }, context)).toBe(false);
    expect(evaluateCondition({ field: "fields.__proto__", operator: "EXISTS" }, context)).toBe(false);
    expect(readPath(context, "fields.constructor")).toBeUndefined();
  });

  it("stops at the depth limit instead of recursing forever", () => {
    let deep: unknown = { field: "issue.type", operator: "EQUALS", value: "BUG" };
    for (let i = 0; i < 20; i++) deep = { not: { not: deep } };
    expect(evaluateCondition(deep, context)).toBe(false);
  });
});

describe("resolveStepConfig", () => {
  it("applies matching overrides in order and drops the overrides key", () => {
    const config = {
      requiredApprovals: 1,
      approverRoles: ["ADMIN"],
      overrides: [
        { when: { field: "fields.riskLevel", operator: "EQUALS", value: "HIGH" }, set: { requiredApprovals: 2 } },
        { when: { field: "entity.name", operator: "CONTAINS", value: "payment" }, set: { approverRoles: ["OWNER"] } },
        { when: { field: "issue.type", operator: "EQUALS", value: "STORY" }, set: { requiredApprovals: 9 } },
      ],
    };
    expect(resolveStepConfig(config, context)).toEqual({ requiredApprovals: 2, approverRoles: ["OWNER"] });
  });

  it("returns {} for non-object configs", () => {
    expect(resolveStepConfig(null, context)).toEqual({});
    expect(resolveStepConfig([1, 2], context)).toEqual({});
  });
});

describe("slugifyKey", () => {
  it("builds lower_snake keys and dedupes", () => {
    expect(slugifyKey("QA Testing", [])).toBe("qa_testing");
    expect(slugifyKey("QA Testing", ["qa_testing"])).toBe("qa_testing_2");
    expect(slugifyKey("QA Testing", ["qa_testing", "qa_testing_2"])).toBe("qa_testing_3");
    expect(slugifyKey("!!!", [])).toBe("step");
  });
});
