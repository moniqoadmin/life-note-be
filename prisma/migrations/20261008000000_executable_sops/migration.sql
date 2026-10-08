CREATE TYPE "SopStepType" AS ENUM (
  'INSTRUCTION', 'CHECKLIST', 'USER_ACTION', 'APPROVAL', 'TESTING',
  'GITHUB_ACTION', 'CONDITION', 'CONFIRMATION', 'AUTOMATED_ACTION'
);
CREATE TYPE "SopAssignmentType" AS ENUM ('ENTITY_INHERITED', 'TASK_OVERRIDE');
CREATE TYPE "RunbookStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'SKIPPED', 'BLOCKED');

ALTER TABLE "sop_steps"
  ADD COLUMN "type" "SopStepType" NOT NULL DEFAULT 'INSTRUCTION',
  ADD COLUMN "config" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "condition" JSONB;

ALTER TABLE "runbook_steps"
  ADD COLUMN "type" "SopStepType" NOT NULL DEFAULT 'INSTRUCTION',
  ADD COLUMN "config" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "condition" JSONB;

ALTER TYPE "RunbookStepStatus" ADD VALUE 'FAILED';
ALTER TYPE "RunbookStepStatus" ADD VALUE 'BLOCKED';

ALTER TABLE "issue_runbooks"
  ADD COLUMN "status" "RunbookStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "assignmentType" "SopAssignmentType",
  ADD COLUMN "currentStepId" TEXT,
  ADD COLUMN "definitionSnapshot" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "components" ADD COLUMN "defaultSopId" TEXT;
ALTER TABLE "issues" ADD COLUMN "sopOverrideId" TEXT;

ALTER TABLE "components"
  ADD CONSTRAINT "components_defaultSopId_fkey"
  FOREIGN KEY ("defaultSopId") REFERENCES "sops"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "issues"
  ADD CONSTRAINT "issues_sopOverrideId_fkey"
  FOREIGN KEY ("sopOverrideId") REFERENCES "sops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');

ALTER TABLE "tasks" ADD COLUMN "sopOverrideId" TEXT;
ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_sopOverrideId_fkey"
  FOREIGN KEY ("sopOverrideId") REFERENCES "sops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "issue_runbooks"
  ALTER COLUMN "issueId" DROP NOT NULL,
  ADD COLUMN "taskId" TEXT;
ALTER TABLE "issue_runbooks"
  ADD CONSTRAINT "issue_runbooks_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "issue_runbooks_target_check"
  CHECK (("issueId" IS NOT NULL AND "taskId" IS NULL) OR ("issueId" IS NULL AND "taskId" IS NOT NULL));
CREATE INDEX "issue_runbooks_taskId_idx" ON "issue_runbooks"("taskId");

CREATE TABLE "runbook_approvals" (
  "id" TEXT NOT NULL,
  "stepId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "decision" "ApprovalDecision" NOT NULL,
  "comment" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "runbook_approvals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "runbook_approvals_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "runbook_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "runbook_approvals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "runbook_approvals_stepId_userId_key" ON "runbook_approvals"("stepId", "userId");
CREATE INDEX "runbook_approvals_stepId_decision_idx" ON "runbook_approvals"("stepId", "decision");

CREATE TABLE "runbook_events" (
  "id" TEXT NOT NULL,
  "runbookId" TEXT NOT NULL,
  "actorId" TEXT,
  "type" TEXT NOT NULL,
  "data" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "runbook_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "runbook_events_runbookId_fkey" FOREIGN KEY ("runbookId") REFERENCES "issue_runbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "runbook_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "runbook_events_runbookId_createdAt_idx" ON "runbook_events"("runbookId", "createdAt");

CREATE TABLE "sop_rules" (
  "id" TEXT NOT NULL,
  "sopId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "condition" JSONB NOT NULL,
  "action" JSONB NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sop_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sop_rules_sopId_fkey" FOREIGN KEY ("sopId") REFERENCES "sops"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "sop_rules_sopId_trigger_enabled_idx" ON "sop_rules"("sopId", "trigger", "enabled");
