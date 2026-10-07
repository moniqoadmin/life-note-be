-- Note issue fields: status/priority/labels on notes, plus note_criteria and
-- note_comments tables. Run against an existing database (e.g. Supabase SQL editor)
-- before deploying the code that reads these columns. Only adds, never drops, and is
-- safe to re-run: anything that already exists (e.g. from an earlier `db push`) is skipped.
-- The IssueStatus/IssuePriority enums must already exist (created with the issues tables).

ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "labels" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "priority" "IssuePriority" NOT NULL DEFAULT 'MEDIUM';
ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "status" "IssueStatus" NOT NULL DEFAULT 'TODO';

CREATE TABLE IF NOT EXISTS "note_criteria" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "note_criteria_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "note_comments" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "note_comments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "note_criteria_noteId_position_idx" ON "note_criteria"("noteId", "position");
CREATE INDEX IF NOT EXISTS "note_comments_noteId_createdAt_idx" ON "note_comments"("noteId", "createdAt");
CREATE INDEX IF NOT EXISTS "notes_userId_status_idx" ON "notes"("userId", "status");

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so check pg_constraint first.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'note_criteria_noteId_fkey') THEN
    ALTER TABLE "note_criteria" ADD CONSTRAINT "note_criteria_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'note_comments_noteId_fkey') THEN
    ALTER TABLE "note_comments" ADD CONSTRAINT "note_comments_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'note_comments_authorId_fkey') THEN
    ALTER TABLE "note_comments" ADD CONSTRAINT "note_comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
