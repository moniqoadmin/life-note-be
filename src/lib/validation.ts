import { z } from "zod";
import { FIELD_PATH_PATTERN, SOP_OPERATORS, UNARY_OPERATORS } from "@/lib/sop/conditions";

const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[a-z]/, "Password must contain a lowercase letter")
  .regex(/[A-Z]/, "Password must contain an uppercase letter")
  .regex(/[0-9]/, "Password must contain a number");

export const registerSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  email: z.string().email(),
  password: passwordSchema,
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const otpSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
});

export const emailOnlySchema = z.object({
  email: z.string().email(),
});

export const resetPasswordSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
  password: passwordSchema,
});

// Free-form custom fields SOP conditions read as `fields.<key>` (e.g. riskLevel: "HIGH").
const customFieldValueSchema = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string().max(200), z.number().finite()])).max(50),
]);
export const customFieldsSchema = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, "Field keys must be letters, digits or _"), customFieldValueSchema)
  .refine((fields) => Object.keys(fields).length <= 50, "Too many custom fields");

export const createNoteSchema = z.object({
  title: z.string().min(1, "Title is required").max(200, "Title is too long"),
  content: z.string().max(50_000, "Content is too long").default(""),
  parentId: z.string().min(1).nullable().optional(),
  sopOverrideId: z.string().min(1).nullable().optional(),
  customFields: customFieldsSchema.optional(),
});

// Notes use the IssueStatus/IssuePriority DB enums but only the values the notes UI offers.
export const noteStatusSchema = z.enum(["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"]);
export const notePrioritySchema = z.enum(["URGENT", "HIGH", "MEDIUM", "LOW"]);

const noteLabelSchema = z.string().trim().min(1, "Label cannot be empty").max(40, "Label is too long");

export const updateNoteSchema = z
  .object({
    title: z.string().min(1, "Title is required").max(200, "Title is too long").optional(),
    content: z.string().max(50_000, "Content is too long").optional(),
    parentId: z.string().min(1).nullable().optional(),
    status: noteStatusSchema.optional(),
    priority: notePrioritySchema.optional(),
    labels: z
      .array(noteLabelSchema)
      .max(20, "Too many labels")
      // Case-insensitive dedupe, keeping the first spelling the user typed.
      .transform((labels) =>
        labels.filter((l, i) => labels.findIndex((x) => x.toLowerCase() === l.toLowerCase()) === i)
      )
      .optional(),
    sopOverrideId: z.string().min(1).nullable().optional(),
    customFields: customFieldsSchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "No fields to update");

export const createNoteCriterionSchema = z.object({
  text: z.string().trim().min(1, "Text is required").max(500, "Text is too long"),
});

export const updateNoteCriterionSchema = z
  .object({
    text: z.string().trim().min(1, "Text is required").max(500, "Text is too long").optional(),
    done: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "No fields to update");

export const createNoteCommentSchema = z.object({
  body: z.string().trim().min(1, "Comment cannot be empty").max(10_000, "Comment is too long"),
});

export const searchNotesSchema = z.object({
  q: z.string().min(1, "Search query is required").max(200, "Search query is too long"),
  rootId: z.string().min(1).nullable().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const createSopSchema = z.object({
  title: z.string().min(1, "Title is required").max(200, "Title is too long"),
  content: z.string().max(50_000, "Content is too long").default(""),
  workspaceId: z.string().min(1).nullable().optional(),
});

export const updateSopSchema = z
  .object({
    title: z.string().min(1, "Title is required").max(200, "Title is too long").optional(),
    content: z.string().max(50_000, "Content is too long").optional(),
    workspaceId: z.string().min(1).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "No fields to update");

export const taskStatusSchema = z.enum(["TODO", "IN_PROGRESS", "DONE"]);

export const createTaskSchema = z.object({
  title: z.string().min(1, "Title is required").max(200, "Title is too long"),
  content: z.string().max(50_000, "Content is too long").default(""),
  status: taskStatusSchema.default("TODO"),
  dueDate: z.coerce.date().nullable().optional(),
  sopOverrideId: z.string().min(1).nullable().optional(),
  customFields: customFieldsSchema.optional(),
});

export const updateTaskSchema = z
  .object({
    title: z.string().min(1, "Title is required").max(200, "Title is too long").optional(),
    content: z.string().max(50_000, "Content is too long").optional(),
    status: taskStatusSchema.optional(),
    dueDate: z.coerce.date().nullable().optional(),
    sopOverrideId: z.string().min(1).nullable().optional(),
    customFields: customFieldsSchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "No fields to update");

// ---------------------------------------------------------------------------
// SOP steps
// ---------------------------------------------------------------------------

// Condition tree — see src/lib/sop/conditions.ts for semantics.
export const sopConditionSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.object({ all: z.array(sopConditionSchema).min(1).max(50) }).strict(),
  z.object({ any: z.array(sopConditionSchema).min(1).max(50) }).strict(),
  z.object({ not: sopConditionSchema }).strict(),
  z.object({
    field: z.string().regex(FIELD_PATH_PATTERN, "Unknown condition field — use e.g. issue.type, fields.riskLevel, steps.<key>.status"),
    operator: z.enum(SOP_OPERATORS),
    value: z.unknown().optional(),
  }).strict().refine(
    (rule) => UNARY_OPERATORS.includes(rule.operator) || rule.value !== undefined,
    "value is required for this operator"
  ).refine(
    (rule) => !["IN", "NOT_IN"].includes(rule.operator) || Array.isArray(rule.value),
    "IN / NOT_IN need an array value"
  ),
]));

export const sopStepTypeSchema = z.enum([
  "INSTRUCTION", "CHECKLIST", "USER_ACTION", "APPROVAL", "TESTING",
  "GITHUB_ACTION", "CONDITION", "CONFIRMATION", "AUTOMATED_ACTION",
]);
export type SopStepTypeInput = z.infer<typeof sopStepTypeSchema>;

export const stepKeySchema = z.string().regex(/^[a-z0-9][a-z0-9_]{0,63}$/, "Keys are lower-case letters, digits and _");
const anyIssueStatus = z.enum(["BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "DONE", "CANCELLED"]);

export const SOP_NOTIFY_RECIPIENTS = ["ASSIGNEE", "REPORTER", "WATCHERS", "OWNER"] as const;

// Rule / automated-step action registry. Adding an action = a schema here plus a
// handler in src/lib/sop/actions.ts; no SOP-specific code anywhere else.
export const sopActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SET_SUBJECT_STATUS"), status: anyIssueStatus }).strict(),
  // Pre-v2 name of SET_SUBJECT_STATUS, still accepted.
  z.object({ type: z.literal("SET_ISSUE_STATUS"), status: anyIssueStatus }).strict(),
  z.object({ type: z.literal("SET_RUNBOOK_STATUS"), status: z.enum(["FAILED", "BLOCKED", "SKIPPED"]) }).strict(),
  z.object({ type: z.literal("GOTO_STEP"), stepKey: stepKeySchema }).strict(),
  z.object({ type: z.literal("SKIP_STEP"), stepKey: stepKeySchema }).strict(),
  z.object({ type: z.literal("ADD_LABEL"), label: z.string().trim().min(1).max(40) }).strict(),
  z.object({ type: z.literal("REMOVE_LABEL"), label: z.string().trim().min(1).max(40) }).strict(),
  z.object({
    type: z.literal("SET_FIELD"),
    field: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
    value: customFieldValueSchema,
  }).strict(),
  z.object({
    type: z.literal("NOTIFY"),
    recipients: z.array(z.enum(SOP_NOTIFY_RECIPIENTS)).max(4).default([]),
    userIds: z.array(z.string().min(1)).max(20).default([]),
    message: z.string().trim().min(1).max(500),
  }).strict(),
]);
export type SopAction = z.infer<typeof sopActionSchema>;

export const SOP_RULE_TRIGGERS = [
  "EXECUTION_STARTED",
  "STEP_STARTED",
  "STEP_COMPLETED",
  "STEP_FAILED",
  "STEP_SKIPPED",
  "STEP_BLOCKED",
  "EXECUTION_COMPLETED",
  "SUBJECT_STATUS_CHANGED",
  "SUBJECT_UPDATED",
  // Pre-v2 name of SUBJECT_STATUS_CHANGED, still accepted.
  "ISSUE_STATUS_CHANGED",
] as const;
export type SopRuleTrigger = (typeof SOP_RULE_TRIGGERS)[number];

// Accepts `action` (one) or `actions` (several); normalized to `actions`.
export const createSopRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    trigger: z.enum(SOP_RULE_TRIGGERS),
    condition: sopConditionSchema.nullable().default(null),
    action: sopActionSchema.optional(),
    actions: z.array(sopActionSchema).min(1).max(10).optional(),
    enabled: z.boolean().default(true),
  })
  .refine((rule) => !!rule.action !== !!rule.actions, "Provide either action or actions")
  .transform(({ action, actions, ...rule }) => ({ ...rule, actions: actions ?? [action!] }));

// --- Per-type step configuration -------------------------------------------
// Every config may carry `overrides: [{ when, set }]` (conditional config, resolved
// when the step starts) and `mandatory` (can't be skipped). Unknown keys are kept so
// clients can store their own presentation hints.
const configOverrideSchema = z.object({ when: sopConditionSchema, set: z.record(z.string(), z.unknown()) }).strict();
const baseStepConfig = z.looseObject({
  overrides: z.array(configOverrideSchema).max(20).optional(),
  mandatory: z.boolean().optional(),
});

export const GITHUB_STEP_EVENTS = [
  "pull_request.opened",
  "pull_request.merged",
  "pull_request.closed",
  "workflow_run.success",
  "push",
] as const;

export const stepConfigSchemas: Record<SopStepTypeInput, z.ZodType<Record<string, unknown>>> = {
  INSTRUCTION: baseStepConfig,
  USER_ACTION: baseStepConfig,
  CONFIRMATION: baseStepConfig.extend({ confirmationText: z.string().max(500).optional() }),
  CHECKLIST: baseStepConfig.extend({
    items: z.array(z.object({
      key: stepKeySchema,
      label: z.string().trim().min(1).max(300),
      required: z.boolean().default(true),
    }).strict()).min(1, "A checklist needs at least one item").max(50)
      .refine((items) => new Set(items.map((i) => i.key)).size === items.length, "Checklist item keys must be unique"),
  }),
  APPROVAL: baseStepConfig.extend({
    requiredApprovals: z.number().int().min(1).max(20).default(1),
    approverIds: z.array(z.string().min(1)).max(50).optional(),
    approverRoles: z.array(z.enum(["OWNER", "ADMIN", "MEMBER"])).max(3).optional(),
    preventSelfApproval: z.boolean().optional(),
  }),
  TESTING: baseStepConfig.extend({ requireResult: z.boolean().default(true) }),
  CONDITION: baseStepConfig.extend({
    check: sopConditionSchema,
    onFalse: z.enum(["FAIL", "BLOCK", "CONTINUE"]).default("FAIL"),
    onTrueGoto: stepKeySchema.optional(),
    onFalseGoto: stepKeySchema.optional(),
  }),
  GITHUB_ACTION: baseStepConfig.extend({
    event: z.enum(GITHUB_STEP_EVENTS).optional(),
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "Use owner/repo").optional(),
    branch: z.string().max(200).optional(),
    workflow: z.string().max(200).optional(),
  }),
  AUTOMATED_ACTION: baseStepConfig.extend({ action: sopActionSchema.optional() }),
};

/** Validates `config` for a step `type`; returns the parsed config or zod issues. */
export function parseStepConfig(type: SopStepTypeInput, config: unknown) {
  return stepConfigSchemas[type].safeParse(config ?? {});
}

export const createSopStepSchema = z.object({
  key: stepKeySchema.optional(),
  title: z.string().min(1, "Title is required").max(200, "Title is too long"),
  description: z.string().max(10_000, "Description is too long").default(""),
  command: z.string().max(2_000, "Command is too long").nullable().optional(),
  requiresSignoff: z.boolean().default(false),
  type: sopStepTypeSchema.default("INSTRUCTION"),
  config: z.record(z.string(), z.unknown()).default({}),
  condition: sopConditionSchema.nullable().optional(),
  position: z.number().int().min(0).optional(),
});

export const updateSopStepSchema = z
  .object({
    key: stepKeySchema.optional(),
    title: z.string().min(1, "Title is required").max(200, "Title is too long").optional(),
    description: z.string().max(10_000, "Description is too long").optional(),
    command: z.string().max(2_000, "Command is too long").nullable().optional(),
    requiresSignoff: z.boolean().optional(),
    type: sopStepTypeSchema.optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    condition: sopConditionSchema.nullable().optional(),
    position: z.number().int().min(0).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "No fields to update");

export const reorderSopStepsSchema = z.object({
  stepIds: z.array(z.string().min(1)).min(1).max(200),
});

// Dry-run a condition against a subject's context (plus optional overrides).
export const evaluateConditionSchema = z
  .object({
    condition: sopConditionSchema,
    issueId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    noteId: z.string().min(1).optional(),
    context: z.record(z.string(), z.unknown()).default({}),
  })
  .refine((d) => [d.issueId, d.taskId, d.noteId].filter(Boolean).length <= 1, "Give at most one of issueId, taskId, noteId");

// --- SOP assignments (entity-level defaults) ---------------------------------
export const sopAssignmentScopeSchema = z.object({
  type: z.enum(["NOTE", "COMPONENT", "PROJECT"]),
  id: z.string().min(1),
});

export const createSopAssignmentSchema = z.object({
  sopId: z.string().min(1),
  scope: sopAssignmentScopeSchema,
  condition: sopConditionSchema.nullable().default(null),
  priority: z.number().int().min(-1000).max(1000).default(0),
});

export const updateSopAssignmentSchema = z
  .object({
    sopId: z.string().min(1).optional(),
    condition: sopConditionSchema.nullable().optional(),
    priority: z.number().int().min(-1000).max(1000).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "No fields to update");

// ---------------------------------------------------------------------------
// Workspaces, members, projects, components
// ---------------------------------------------------------------------------

const nameSchema = z.string().trim().min(1, "Name is required").max(100, "Name is too long");
const descriptionSchema = z.string().max(10_000, "Description is too long");
const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Color must be a hex value like #3b82f6")
  .nullable();
const idRefSchema = z.string().min(1).nullable();

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const createWorkspaceSchema = z.object({ name: nameSchema });
export const updateWorkspaceSchema = z.object({ name: nameSchema });

export const assignableRoleSchema = z.enum(["ADMIN", "MEMBER"]);

export const addMemberSchema = z.object({
  email: z.string().email(),
  role: assignableRoleSchema.default("MEMBER"),
});

export const updateMemberSchema = z.object({ role: assignableRoleSchema });

export const createProjectSchema = z.object({
  key: z
    .string()
    .regex(/^[A-Z][A-Z0-9]{1,9}$/, "Key must be 2-10 uppercase letters/digits, starting with a letter"),
  name: nameSchema,
  description: descriptionSchema.default(""),
  color: colorSchema.optional(),
  leadId: idRefSchema.optional(),
});

export const updateProjectSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    color: colorSchema.optional(),
    leadId: idRefSchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "No fields to update");

export const createComponentSchema = z.object({
  name: nameSchema,
  description: descriptionSchema.default(""),
});

export const updateComponentSchema = z
  .object({ name: nameSchema.optional(), description: descriptionSchema.optional(), defaultSopId: z.string().min(1).nullable().optional() })
  .refine((data) => Object.keys(data).length > 0, "No fields to update");

// ---------------------------------------------------------------------------
// Sprints, epics, releases
// ---------------------------------------------------------------------------

export const sprintStatusSchema = z.enum(["PLANNED", "ACTIVE", "COMPLETED"]);

export const createSprintSchema = z.object({
  name: nameSchema,
  goal: descriptionSchema.default(""),
  status: sprintStatusSchema.default("PLANNED"),
  startDate: z.coerce.date().nullable().optional(),
  endDate: z.coerce.date().nullable().optional(),
});

export const updateSprintSchema = z
  .object({
    name: nameSchema.optional(),
    goal: descriptionSchema.optional(),
    status: sprintStatusSchema.optional(),
    startDate: z.coerce.date().nullable().optional(),
    endDate: z.coerce.date().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "No fields to update");

export const epicStatusSchema = z.enum(["OPEN", "IN_PROGRESS", "DONE"]);

export const createEpicSchema = z.object({
  name: nameSchema,
  description: descriptionSchema.default(""),
  color: colorSchema.optional(),
  status: epicStatusSchema.default("OPEN"),
  startDate: z.coerce.date().nullable().optional(),
  targetDate: z.coerce.date().nullable().optional(),
});

export const updateEpicSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    color: colorSchema.optional(),
    status: epicStatusSchema.optional(),
    startDate: z.coerce.date().nullable().optional(),
    targetDate: z.coerce.date().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "No fields to update");

export const releaseStatusSchema = z.enum(["UNRELEASED", "RELEASED", "ARCHIVED"]);

export const createReleaseSchema = z.object({
  name: nameSchema,
  description: descriptionSchema.default(""),
  status: releaseStatusSchema.default("UNRELEASED"),
  releaseDate: z.coerce.date().nullable().optional(),
});

export const updateReleaseSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    status: releaseStatusSchema.optional(),
    releaseDate: z.coerce.date().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "No fields to update");

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export const issueTypeSchema = z.enum(["STORY", "TASK", "BUG", "SECURITY", "SPIKE"]);
export const issueStatusSchema = z.enum([
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "IN_REVIEW",
  "DONE",
  "CANCELLED",
]);
export const issuePrioritySchema = z.enum(["URGENT", "HIGH", "MEDIUM", "LOW", "NONE"]);

const labelsSchema = z
  .array(z.string().trim().min(1).max(50, "Label is too long"))
  .max(20, "Too many labels")
  .transform((labels) => [...new Set(labels)]);

const issueFields = {
  type: issueTypeSchema,
  title: z.string().trim().min(1, "Title is required").max(300, "Title is too long"),
  description: z.string().max(100_000, "Description is too long"),
  status: issueStatusSchema,
  priority: issuePrioritySchema,
  storyPoints: z.number().int().min(0).max(1000).nullable(),
  labels: labelsSchema,
  estimateMinutes: z.number().int().min(0).max(1_000_000).nullable(),
  dueDate: z.coerce.date().nullable(),
  slaDueAt: z.coerce.date().nullable(),
  assigneeId: idRefSchema,
  parentId: idRefSchema,
  componentId: idRefSchema,
  epicId: idRefSchema,
  sprintId: idRefSchema,
  releaseId: idRefSchema,
};

export const createIssueSchema = z.object({
  ...issueFields,
  type: issueFields.type.default("TASK"),
  description: issueFields.description.default(""),
  status: issueFields.status.default("BACKLOG"),
  priority: issueFields.priority.default("NONE"),
  labels: labelsSchema.default([]),
  storyPoints: issueFields.storyPoints.optional(),
  estimateMinutes: issueFields.estimateMinutes.optional(),
  dueDate: issueFields.dueDate.optional(),
  slaDueAt: issueFields.slaDueAt.optional(),
  assigneeId: issueFields.assigneeId.optional(),
  parentId: issueFields.parentId.optional(),
  componentId: issueFields.componentId.optional(),
  epicId: issueFields.epicId.optional(),
  sprintId: issueFields.sprintId.optional(),
  releaseId: issueFields.releaseId.optional(),
  sopOverrideId: z.string().min(1).nullable().optional(),
  customFields: customFieldsSchema.optional(),
});

export const updateIssueSchema = z
  .object({ ...issueFields, position: z.number().finite(), sopOverrideId: z.string().min(1).nullable(), customFields: customFieldsSchema })
  .partial()
  .refine((data) => Object.keys(data).length > 0, "No fields to update");

// `assigneeId`/`reporterId` accept "me"; `assigneeId`/`parentId`/`sprintId`/`epicId`
// accept "none" to match unset values (e.g. unassigned, top-level, backlog).
export const listIssuesQuerySchema = paginationSchema.extend({
  projectId: z.string().min(1).optional(),
  status: issueStatusSchema.optional(),
  type: issueTypeSchema.optional(),
  priority: issuePrioritySchema.optional(),
  assigneeId: z.string().min(1).optional(),
  reporterId: z.string().min(1).optional(),
  parentId: z.string().min(1).optional(),
  componentId: z.string().min(1).optional(),
  epicId: z.string().min(1).optional(),
  sprintId: z.string().min(1).optional(),
  releaseId: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  updatedSince: z.coerce.date().optional(),
  sort: z.enum(["updated", "created", "position", "priority"]).default("updated"),
});

export const createCriterionSchema = z.object({
  text: z.string().trim().min(1, "Text is required").max(2_000, "Text is too long"),
  done: z.boolean().default(false),
});

export const updateCriterionSchema = z
  .object({
    text: z.string().trim().min(1, "Text is required").max(2_000, "Text is too long").optional(),
    done: z.boolean().optional(),
    position: z.number().int().min(0).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "No fields to update");

export const createRelationSchema = z.object({
  targetIssueId: z.string().min(1),
  type: z.enum(["BLOCKS", "BLOCKED_BY", "RELATES_TO", "DUPLICATES", "DUPLICATED_BY"]),
});

export const createCommentSchema = z.object({
  body: z.string().trim().min(1, "Comment is empty").max(20_000, "Comment is too long"),
  parentId: z.string().min(1).nullable().optional(),
});

export const updateCommentSchema = z.object({
  body: z.string().trim().min(1, "Comment is empty").max(20_000, "Comment is too long"),
});

export const createWorkLogSchema = z.object({
  minutes: z.number().int().min(1).max(24 * 60 * 7),
  note: z.string().max(2_000, "Note is too long").default(""),
  startedAt: z.coerce.date().optional(),
});

export const updateWorkLogSchema = z
  .object({
    minutes: z.number().int().min(1).max(24 * 60 * 7).optional(),
    note: z.string().max(2_000, "Note is too long").optional(),
    startedAt: z.coerce.date().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "No fields to update");

export const createAttachmentSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().min(0).max(2_000_000_000),
  url: z.string().url().max(2_000).refine((u) => /^https?:\/\//i.test(u), "URL must be http(s)"),
});

export const devLinkTypeSchema = z.enum(["BRANCH", "PULL_REQUEST", "COMMIT", "BUILD"]);

const httpUrlSchema = z
  .string()
  .url()
  .max(2_000)
  .refine((u) => /^https?:\/\//i.test(u), "URL must be http(s)");

export const createDevLinkSchema = z.object({
  type: devLinkTypeSchema,
  title: z.string().trim().min(1).max(300),
  url: httpUrlSchema.nullable().optional(),
  externalId: z.string().max(200).nullable().optional(),
  status: z.string().max(50).nullable().optional(),
});

export const updateDevLinkSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    url: httpUrlSchema.nullable().optional(),
    externalId: z.string().max(200).nullable().optional(),
    status: z.string().max(50).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "No fields to update");

export const runbookModeSchema = z.enum(["MANUAL", "AUTOMATED"]);

export const attachRunbookSchema = z.object({
  sopId: z.string().min(1),
  mode: runbookModeSchema.default("MANUAL"),
});

export const updateRunbookSchema = z
  .object({
    mode: runbookModeSchema.optional(),
    // CANCEL stops a running execution (kept for history); RESTART rewinds to the first step.
    action: z.enum(["CANCEL", "RESTART"]).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "No fields to update");

// `status` drives the step: VERIFIED completes it, FAILED / BLOCKED / SKIPPED do what
// they say, IN_PROGRESS on a blocked/failed step retries it and on an earlier finished
// step rewinds the execution to it (PENDING is accepted as a synonym for rewinding).
export const updateRunbookStepSchema = z
  .object({
    status: z.enum(["PENDING", "IN_PROGRESS", "VERIFIED", "FAILED", "BLOCKED", "SKIPPED"]).optional(),
    notes: z.string().max(10_000, "Notes are too long").optional(),
    output: z.string().max(50_000, "Output is too long").optional(),
    executor: z.string().max(200).nullable().optional(),
    // TESTING steps: PASSED completes the step, FAILED fails it.
    result: z.enum(["PASSED", "FAILED"]).optional(),
    // CHECKLIST steps: { <itemKey>: done }.
    checklist: z.record(z.string(), z.boolean()).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "No fields to update");
export type RunbookStepUpdate = z.infer<typeof updateRunbookStepSchema>;

export const createRunbookApprovalSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  comment: z.string().max(10_000).default(""),
});

export const stepCallbackSchema = z.object({
  status: z.enum(["SUCCESS", "FAILURE"]),
  output: z.string().max(50_000).optional(),
  executor: z.string().max(200).optional(),
});

export const workspaceSearchSchema = z.object({
  q: z.string().trim().min(1, "Search query is required").max(200, "Search query is too long"),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const listNotificationsQuerySchema = paginationSchema.extend({
  unread: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

export const updateNotificationSchema = z.object({ read: z.boolean() });
