import { z } from "zod";
import { CONDITION_FIELD_PATTERN, CONDITION_OPERATORS, CONDITION_ROOTS } from "@/lib/sop-conditions";

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

export const createNoteSchema = z.object({
  title: z.string().min(1, "Title is required").max(200, "Title is too long"),
  content: z.string().max(50_000, "Content is too long").default(""),
  parentId: z.string().min(1).nullable().optional(),
  // This note's own SOP (overrides anything inherited from an ancestor).
  sopOverrideId: z.string().min(1).nullable().optional(),
  // Default SOP for notes created under this one later (makes it an "entity").
  defaultSopId: z.string().min(1).nullable().optional(),
});

export const updateNoteSchema = z
  .object({
    title: z.string().min(1, "Title is required").max(200, "Title is too long").optional(),
    content: z.string().max(50_000, "Content is too long").optional(),
    parentId: z.string().min(1).nullable().optional(),
    sopOverrideId: z.string().min(1).nullable().optional(),
    defaultSopId: z.string().min(1).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "No fields to update");

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
});

export const updateTaskSchema = z
  .object({
    title: z.string().min(1, "Title is required").max(200, "Title is too long").optional(),
    content: z.string().max(50_000, "Content is too long").optional(),
    status: taskStatusSchema.optional(),
    dueDate: z.coerce.date().nullable().optional(),
    sopOverrideId: z.string().min(1).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "No fields to update");

// ---------------------------------------------------------------------------
// SOP steps
// ---------------------------------------------------------------------------

const stepKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, "Step key must be lowercase letters, digits, - or _ (max 63)");

export const sopConditionSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.object({ all: z.array(sopConditionSchema).min(1).max(50) }).strict(),
  z.object({ any: z.array(sopConditionSchema).min(1).max(50) }).strict(),
  z.object({ not: sopConditionSchema }).strict(),
  z.object({
    field: z.string().max(200).regex(CONDITION_FIELD_PATTERN, `field must be a dotted path starting with ${CONDITION_ROOTS.join(", ")}`),
    operator: z.enum(CONDITION_OPERATORS),
    value: z.unknown().optional(),
  }).strict().refine(
    (rule) => rule.operator === "EXISTS" || rule.operator === "NOT_EXISTS" || rule.value !== undefined,
    "value is required for this operator",
  ).refine(
    (rule) => !["IN", "NOT_IN"].includes(rule.operator) || Array.isArray(rule.value),
    "value must be an array for IN / NOT_IN",
  ),
]));

const customFieldValueSchema = z.union([
  z.string().max(1_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(200)).max(50),
]);

export const customFieldsSchema = z
  .record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Custom field names are letters, digits, - or _"), customFieldValueSchema)
  .refine((fields) => Object.keys(fields).length <= 50, "Too many custom fields");

const issueStatusValues = ["BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "DONE", "CANCELLED"] as const;

/** The action registry shared by rules and AUTOMATED_ACTION steps (executed in sop-engine.ts). */
export const sopActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SET_ISSUE_STATUS"), status: z.enum(issueStatusValues) }).strict(),
  z.object({ type: z.literal("SET_TASK_STATUS"), status: z.enum(["TODO", "IN_PROGRESS", "DONE"]) }).strict(),
  z.object({ type: z.literal("SET_RUNBOOK_STATUS"), status: z.enum(["FAILED", "BLOCKED", "SKIPPED"]) }).strict(),
  z.object({ type: z.literal("GO_TO_STEP"), stepKey: stepKeySchema }).strict(),
  z.object({ type: z.literal("SKIP_STEP"), stepKey: stepKeySchema }).strict(),
  z.object({ type: z.literal("REQUIRE_APPROVALS"), stepKey: stepKeySchema, count: z.number().int().min(1).max(20) }).strict(),
  z.object({ type: z.literal("SET_STEP_CONFIG"), stepKey: stepKeySchema, config: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ type: z.literal("ADD_LABEL"), label: z.string().trim().min(1).max(50) }).strict(),
  z.object({ type: z.literal("REMOVE_LABEL"), label: z.string().trim().min(1).max(50) }).strict(),
  z.object({ type: z.literal("ASSIGN_ISSUE"), userId: z.string().min(1).nullable() }).strict(),
  z.object({ type: z.literal("SET_ISSUE_FIELD"), field: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), value: customFieldValueSchema }).strict(),
]);

export type SopAction = z.infer<typeof sopActionSchema>;

export const SOP_RULE_TRIGGERS = [
  "EXECUTION_STARTED",
  "EXECUTION_COMPLETED",
  "STEP_STARTED",
  "STEP_COMPLETED",
  "STEP_FAILED",
  "STEP_BLOCKED",
  "STEP_SKIPPED",
  "ISSUE_UPDATED",
  "ISSUE_STATUS_CHANGED",
  "TASK_UPDATED",
  "NOTE_UPDATED",
] as const;

const ruleFields = {
  name: z.string().trim().min(1).max(200),
  trigger: z.enum(SOP_RULE_TRIGGERS),
  condition: sopConditionSchema,
  actions: z.array(sopActionSchema).min(1).max(20),
  enabled: z.boolean(),
};

// Accepts the legacy single `action` as an alias for `actions: [action]`.
const legacyRuleAction = (body: unknown) => {
  if (body && typeof body === "object" && !Array.isArray(body) && "action" in body && !("actions" in body)) {
    const { action, ...rest } = body as Record<string, unknown>;
    return { ...rest, actions: [action] };
  }
  return body;
};

export const createSopRuleSchema = z.preprocess(
  legacyRuleAction,
  z.object({ ...ruleFields, enabled: ruleFields.enabled.default(true) }),
);

export const updateSopRuleSchema = z.preprocess(
  legacyRuleAction,
  z.object(ruleFields).partial().refine((data) => Object.keys(data).length > 0, "No fields to update"),
);

const approverRoles = z.array(z.enum(["OWNER", "ADMIN", "MEMBER"])).max(3);

/** Who may complete (or, for APPROVAL, approve) a step. Omitted = anyone with access. */
const stepPermissionFields = {
  allowedUserIds: z.array(z.string().min(1)).max(50).optional(),
  allowedRoles: approverRoles.optional(),
};

const transitionSchema = z.discriminatedUnion("then", [
  z.object({ then: z.literal("CONTINUE") }).strict(),
  z.object({ then: z.literal("FAIL") }).strict(),
  z.object({ then: z.literal("BLOCK") }).strict(),
  z.object({ then: z.literal("GO_TO_STEP"), stepKey: stepKeySchema }).strict(),
]);

/**
 * Per-type step config. Unknown extra keys are kept (`loose`) so clients can store
 * UI hints, but every key the engine reads is validated here.
 */
export const stepConfigSchemas = {
  INSTRUCTION: z.looseObject({ ...stepPermissionFields }),
  USER_ACTION: z.looseObject({ ...stepPermissionFields }),
  CONFIRMATION: z.looseObject({ ...stepPermissionFields, prompt: z.string().max(1_000).optional() }),
  TESTING: z.looseObject({ ...stepPermissionFields }),
  CHECKLIST: z.looseObject({
    ...stepPermissionFields,
    items: z.array(z.object({
      id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      label: z.string().min(1).max(500),
      required: z.boolean().default(true),
    }).strict()).min(1).max(100)
      .refine((items) => new Set(items.map((i) => i.id)).size === items.length, "Checklist item ids must be unique"),
  }),
  APPROVAL: z.looseObject({
    requiredApprovals: z.number().int().min(1).max(20).default(1),
    approvers: z.object({
      userIds: z.array(z.string().min(1)).max(50).optional(),
      roles: approverRoles.optional(),
      projectLead: z.boolean().optional(),
    }).strict().optional(),
  }),
  GITHUB_ACTION: z.looseObject({
    ...stepPermissionFields,
    event: z.enum(["PR_OPENED", "PR_MERGED", "CHECKS_PASSED"]),
    baseBranch: z.string().min(1).max(200).optional(),
    allowManualCompletion: z.boolean().default(true),
  }),
  CONDITION: z.looseObject({
    condition: sopConditionSchema,
    onTrue: transitionSchema.default({ then: "CONTINUE" }),
    onFalse: transitionSchema.default({ then: "FAIL" }),
  }),
  AUTOMATED_ACTION: z.looseObject({
    actions: z.array(sopActionSchema).min(1).max(20),
  }),
} as const;

export const sopStepTypeSchema = z.enum([
  "INSTRUCTION", "CHECKLIST", "USER_ACTION", "APPROVAL", "TESTING",
  "GITHUB_ACTION", "CONDITION", "CONFIRMATION", "AUTOMATED_ACTION",
]);

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
  stepIds: z.array(z.string().min(1)).min(1).max(500),
});

export const evaluateConditionSchema = z
  .object({
    condition: sopConditionSchema,
    issueId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    noteId: z.string().min(1).optional(),
    // Extra/overriding context values for "what if" testing, e.g. { "steps": { ... } }.
    context: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((data) => [data.issueId, data.taskId, data.noteId].filter(Boolean).length <= 1, "Pass at most one of issueId, taskId, noteId");

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

const githubRepoSchema = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/, 'githubRepo must look like "owner/repo"')
  .transform((repo) => repo.toLowerCase())
  .nullable();

export const createProjectSchema = z.object({
  key: z
    .string()
    .regex(/^[A-Z][A-Z0-9]{1,9}$/, "Key must be 2-10 uppercase letters/digits, starting with a letter"),
  name: nameSchema,
  description: descriptionSchema.default(""),
  color: colorSchema.optional(),
  leadId: idRefSchema.optional(),
  githubRepo: githubRepoSchema.optional(),
});

export const updateProjectSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    color: colorSchema.optional(),
    leadId: idRefSchema.optional(),
    githubRepo: githubRepoSchema.optional(),
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
  customFields: customFieldsSchema,
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
  customFields: customFieldsSchema.default({}),
  sopOverrideId: z.string().min(1).nullable().optional(),
});

export const updateIssueSchema = z
  .object({ ...issueFields, position: z.number().finite(), sopOverrideId: z.string().min(1).nullable() })
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
    // Cancel the execution (pending steps are skipped).
    status: z.literal("SKIPPED").optional(),
    // Jump to a step by key, backwards (re-run) or forwards (skip ahead).
    goToStep: stepKeySchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "No fields to update");

export const updateRunbookStepSchema = z
  .object({
    status: z.enum(["PENDING", "IN_PROGRESS", "VERIFIED", "FAILED", "BLOCKED", "SKIPPED"]).optional(),
    notes: z.string().max(10_000, "Notes are too long").optional(),
    output: z.string().max(50_000, "Output is too long").optional(),
    executor: z.string().max(200).nullable().optional(),
    // TESTING: PASSED / FAILED (FAILED fails the step). Other types: free-form outcome.
    result: z.string().trim().min(1).max(50).optional(),
    // CHECKLIST: ids of the config items that are ticked (replaces the previous set).
    checkedItems: z.array(z.string().min(1).max(64)).max(100).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "No fields to update");

export const createRunbookApprovalSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  comment: z.string().max(10_000).default(""),
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
