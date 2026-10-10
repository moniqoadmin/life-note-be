import { SOP_OPERATORS, UNARY_OPERATORS } from "@/lib/sop/conditions";
import { GITHUB_STEP_EVENTS, SOP_NOTIFY_RECIPIENTS, SOP_RULE_TRIGGERS } from "@/lib/validation";

// Self-description of the SOP engine (GET /sop-meta), so clients build their step,
// condition and rule editors from data instead of hardcoding the engine's vocabulary.

const ISSUE_STATUSES = ["BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "DONE", "CANCELLED"];
const STEP_STATUSES = ["PENDING", "IN_PROGRESS", "VERIFIED", "SKIPPED", "FAILED", "BLOCKED"];

export const SOP_CATALOG = {
  stepTypes: [
    { type: "INSTRUCTION", label: "Instruction", description: "Read and confirm; completes manually." },
    { type: "CHECKLIST", label: "Checklist", description: "Every required item must be ticked.", config: ["items"] },
    { type: "USER_ACTION", label: "User action", description: "Someone does something and marks it done." },
    {
      type: "APPROVAL", label: "Approval", description: "Needs N approvals; one rejection fails it.",
      config: ["requiredApprovals", "approverIds", "approverRoles", "preventSelfApproval"],
    },
    { type: "TESTING", label: "Testing", description: "Record PASSED or FAILED; FAILED fails the step.", config: ["requireResult"] },
    {
      type: "GITHUB_ACTION", label: "GitHub action",
      description: "Waits for a GitHub event (PR opened/merged, workflow success, push) or a callback.",
      config: ["event", "repository", "branch", "workflow"],
    },
    {
      type: "CONDITION", label: "Condition", description: "Evaluated automatically; branches or fails/blocks when false.",
      config: ["check", "onFalse", "onTrueGoto", "onFalseGoto"],
    },
    { type: "CONFIRMATION", label: "Confirmation", description: "An explicit yes before continuing.", config: ["confirmationText"] },
    {
      type: "AUTOMATED_ACTION", label: "Automated action",
      description: "Runs an action immediately (e.g. set status), or waits for an external callback.",
      config: ["action"],
    },
  ],
  operators: SOP_OPERATORS.map((op) => ({
    operator: op,
    unary: UNARY_OPERATORS.includes(op),
    arrayValue: op === "IN" || op === "NOT_IN",
  })),
  fields: [
    { path: "issue.type", label: "Ticket type", kind: "enum", values: ["STORY", "TASK", "BUG", "SECURITY", "SPIKE"], subjects: ["ISSUE"] },
    { path: "issue.status", label: "Status", kind: "enum", values: ISSUE_STATUSES },
    { path: "issue.priority", label: "Priority", kind: "enum", values: ["URGENT", "HIGH", "MEDIUM", "LOW", "NONE"] },
    { path: "issue.labels", label: "Labels", kind: "list" },
    { path: "issue.title", label: "Title", kind: "text" },
    { path: "issue.storyPoints", label: "Story points", kind: "number", subjects: ["ISSUE"] },
    { path: "entity.name", label: "Entity name (component / project / module)", kind: "text" },
    { path: "entity.kind", label: "Entity kind", kind: "enum", values: ["COMPONENT", "PROJECT", "MODULE"] },
    { path: "parent.title", label: "Parent title", kind: "text", subjects: ["NOTE"] },
    { path: "note.depth", label: "Depth in tree (0 = module, 2+ = ticket)", kind: "number", subjects: ["NOTE"] },
    { path: "fields.<key>", label: "Custom field", kind: "custom" },
    { path: "steps.<key>.status", label: "Step status", kind: "enum", values: STEP_STATUSES },
    { path: "steps.<key>.result", label: "Step result (testing PASSED/FAILED, condition TRUE/FALSE)", kind: "text" },
    { path: "steps.<key>.approvals", label: "Step approval count", kind: "number" },
    { path: "execution.status", label: "Execution status", kind: "enum", values: ["PENDING", "IN_PROGRESS", "COMPLETED", "FAILED", "SKIPPED", "BLOCKED"] },
    { path: "execution.assignmentType", label: "Assignment type", kind: "enum", values: ["ENTITY_INHERITED", "TASK_OVERRIDE", "MANUAL"] },
    { path: "trigger.stepKey", label: "Triggering step (rules only)", kind: "step" },
    { path: "trigger.stepType", label: "Triggering step type (rules only)", kind: "text" },
  ],
  triggers: SOP_RULE_TRIGGERS.filter((t) => t !== "ISSUE_STATUS_CHANGED"),
  actions: [
    { type: "SET_SUBJECT_STATUS", label: "Set task status", params: ["status"], statuses: ISSUE_STATUSES },
    { type: "SET_RUNBOOK_STATUS", label: "Set execution status", params: ["status"], statuses: ["FAILED", "BLOCKED", "SKIPPED"] },
    { type: "GOTO_STEP", label: "Go back / jump to step", params: ["stepKey"] },
    { type: "SKIP_STEP", label: "Skip step", params: ["stepKey"] },
    { type: "ADD_LABEL", label: "Add label", params: ["label"] },
    { type: "REMOVE_LABEL", label: "Remove label", params: ["label"] },
    { type: "SET_FIELD", label: "Set custom field", params: ["field", "value"] },
    { type: "NOTIFY", label: "Notify", params: ["recipients", "userIds", "message"] },
  ],
  notifyRecipients: SOP_NOTIFY_RECIPIENTS,
  githubEvents: GITHUB_STEP_EVENTS,
};
