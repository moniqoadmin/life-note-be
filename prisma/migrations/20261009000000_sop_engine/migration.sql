-- SOP engine: stable step keys, per-attempt step state, execution timestamps,
-- multi-action rules, issue custom fields and GitHub repo mapping.

ALTER TYPE "SopAssignmentType" ADD VALUE 'MANUAL';

-- Stable step keys. Existing steps get "step-<n>" in their current order.
ALTER TABLE "sop_steps" ADD COLUMN "key" TEXT;
UPDATE "sop_steps" s SET "key" = 'step-' || ranked.n
FROM (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "sopId" ORDER BY "position", "createdAt") AS n
  FROM "sop_steps"
) ranked
WHERE s."id" = ranked."id";
ALTER TABLE "sop_steps" ALTER COLUMN "key" SET NOT NULL;
CREATE UNIQUE INDEX "sop_steps_sopId_key_key" ON "sop_steps"("sopId", "key");

ALTER TABLE "runbook_steps"
  ADD COLUMN "key" TEXT,
  ADD COLUMN "result" TEXT,
  ADD COLUMN "data" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "startedAt" TIMESTAMP(3);
UPDATE "runbook_steps" s SET "key" = 'step-' || ranked.n
FROM (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "runbookId" ORDER BY "position", "createdAt") AS n
  FROM "runbook_steps"
) ranked
WHERE s."id" = ranked."id";
ALTER TABLE "runbook_steps" ALTER COLUMN "key" SET NOT NULL;
CREATE UNIQUE INDEX "runbook_steps_runbookId_key_key" ON "runbook_steps"("runbookId", "key");

-- Approvals are scoped to a step attempt so a retried approval step starts fresh.
ALTER TABLE "runbook_approvals" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1;
DROP INDEX "runbook_approvals_stepId_userId_key";
CREATE UNIQUE INDEX "runbook_approvals_stepId_userId_attempt_key" ON "runbook_approvals"("stepId", "userId", "attempt");

ALTER TABLE "issue_runbooks"
  ADD COLUMN "startedAt" TIMESTAMP(3),
  ADD COLUMN "completedAt" TIMESTAMP(3);
CREATE INDEX "issue_runbooks_sopId_status_idx" ON "issue_runbooks"("sopId", "status");
-- Created by the previous migration, but missing on databases synced with `db push`.
CREATE INDEX IF NOT EXISTS "issue_runbooks_taskId_idx" ON "issue_runbooks"("taskId");

-- Rules run an ordered list of actions instead of a single one.
ALTER TABLE "sop_rules" ADD COLUMN "actions" JSONB;
UPDATE "sop_rules" SET "actions" = jsonb_build_array("action");
ALTER TABLE "sop_rules" ALTER COLUMN "actions" SET NOT NULL;
ALTER TABLE "sop_rules" DROP COLUMN "action";

ALTER TABLE "issues" ADD COLUMN "customFields" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "projects" ADD COLUMN "githubRepo" TEXT;
CREATE INDEX "projects_githubRepo_idx" ON "projects"("githubRepo");

-- Notes as SOP targets: own SOP (override) and a default SOP their descendants inherit.
ALTER TABLE "notes"
  ADD COLUMN "sopOverrideId" TEXT,
  ADD COLUMN "defaultSopId" TEXT;
ALTER TABLE "notes"
  ADD CONSTRAINT "notes_sopOverrideId_fkey"
  FOREIGN KEY ("sopOverrideId") REFERENCES "sops"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "notes_defaultSopId_fkey"
  FOREIGN KEY ("defaultSopId") REFERENCES "sops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "issue_runbooks" ADD COLUMN "noteId" TEXT;
ALTER TABLE "issue_runbooks"
  ADD CONSTRAINT "issue_runbooks_noteId_fkey"
  FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "issue_runbooks_noteId_idx" ON "issue_runbooks"("noteId");
ALTER TABLE "issue_runbooks" DROP CONSTRAINT IF EXISTS "issue_runbooks_target_check";
ALTER TABLE "issue_runbooks" ADD CONSTRAINT "issue_runbooks_target_check"
  CHECK (num_nonnulls("issueId", "taskId", "noteId") = 1);
