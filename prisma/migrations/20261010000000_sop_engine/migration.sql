-- SOP engine v2: subject-agnostic executions (issues, notes, tasks), stable step keys,
-- published SOP versions, entity-level SOP assignments with conditions, custom fields
-- for conditions, and per-step runtime state (checklists, test results, callbacks).

ALTER TYPE "SopAssignmentType" ADD VALUE 'MANUAL';
ALTER TYPE "NotificationType" ADD VALUE 'SOP';

-- Custom fields readable by SOP conditions as `fields.<key>`.
ALTER TABLE "issues" ADD COLUMN "customFields" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "tasks" ADD COLUMN "customFields" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "notes"
  ADD COLUMN "customFields" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "sopOverrideId" TEXT;
ALTER TABLE "notes"
  ADD CONSTRAINT "notes_sopOverrideId_fkey"
  FOREIGN KEY ("sopOverrideId") REFERENCES "sops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sops" ADD COLUMN "publishedVersion" INTEGER;

-- Stable step keys. Existing steps get step_<n> from their 0-based position.
ALTER TABLE "sop_steps" ADD COLUMN "key" TEXT;
UPDATE "sop_steps" SET "key" = 'step_' || ("position" + 1);
ALTER TABLE "sop_steps" ALTER COLUMN "key" SET NOT NULL;
CREATE UNIQUE INDEX "sop_steps_sopId_key_key" ON "sop_steps"("sopId", "key");

CREATE TABLE "sop_versions" (
  "id" TEXT NOT NULL,
  "sopId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "definition" JSONB NOT NULL,
  "publishedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sop_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sop_versions_sopId_fkey" FOREIGN KEY ("sopId") REFERENCES "sops"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sop_versions_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "sop_versions_sopId_version_key" ON "sop_versions"("sopId", "version");

CREATE TABLE "sop_assignments" (
  "id" TEXT NOT NULL,
  "sopId" TEXT NOT NULL,
  "projectId" TEXT,
  "componentId" TEXT,
  "noteId" TEXT,
  "condition" JSONB,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sop_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sop_assignments_sopId_fkey" FOREIGN KEY ("sopId") REFERENCES "sops"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sop_assignments_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sop_assignments_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "components"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sop_assignments_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sop_assignments_scope_check" CHECK (
    (("projectId" IS NOT NULL)::int + ("componentId" IS NOT NULL)::int + ("noteId" IS NOT NULL)::int) = 1
  )
);
CREATE INDEX "sop_assignments_projectId_priority_idx" ON "sop_assignments"("projectId", "priority");
CREATE INDEX "sop_assignments_componentId_priority_idx" ON "sop_assignments"("componentId", "priority");
CREATE INDEX "sop_assignments_noteId_priority_idx" ON "sop_assignments"("noteId", "priority");
CREATE INDEX "sop_assignments_sopId_idx" ON "sop_assignments"("sopId");

-- Move component default SOPs into unconditional assignments, then drop the column.
INSERT INTO "sop_assignments" ("id", "sopId", "componentId", "priority", "updatedAt")
SELECT 'cmp_' || "id", "defaultSopId", "id", 0, CURRENT_TIMESTAMP
FROM "components" WHERE "defaultSopId" IS NOT NULL;
ALTER TABLE "components" DROP CONSTRAINT "components_defaultSopId_fkey";
ALTER TABLE "components" DROP COLUMN "defaultSopId";

-- Executions can now target notes; exactly one subject per execution.
ALTER TABLE "issue_runbooks"
  ADD COLUMN "noteId" TEXT,
  ADD COLUMN "completedAt" TIMESTAMP(3);
ALTER TABLE "issue_runbooks"
  ADD CONSTRAINT "issue_runbooks_noteId_fkey"
  FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "issue_runbooks" DROP CONSTRAINT "issue_runbooks_target_check";
ALTER TABLE "issue_runbooks" ADD CONSTRAINT "issue_runbooks_target_check" CHECK (
  (("issueId" IS NOT NULL)::int + ("taskId" IS NOT NULL)::int + ("noteId" IS NOT NULL)::int) = 1
);
CREATE INDEX IF NOT EXISTS "issue_runbooks_taskId_idx" ON "issue_runbooks"("taskId");
CREATE INDEX "issue_runbooks_noteId_idx" ON "issue_runbooks"("noteId");

-- Per-step runtime state.
ALTER TABLE "runbook_steps"
  ADD COLUMN "key" TEXT,
  ADD COLUMN "data" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "result" TEXT,
  ADD COLUMN "callbackToken" TEXT,
  ADD COLUMN "startedAt" TIMESTAMP(3);
UPDATE "runbook_steps" SET "key" = 'step_' || ("position" + 1);
CREATE UNIQUE INDEX "runbook_steps_callbackToken_key" ON "runbook_steps"("callbackToken");
