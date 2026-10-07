-- Note issue fields: status/priority/labels on notes, plus note_criteria and
-- note_comments tables. Run ONCE against an existing database (e.g. Supabase SQL
-- editor) before deploying the code that reads these columns. Generated with
-- `prisma migrate diff` from the previous schema; it only adds, never drops.
-- The IssueStatus/IssuePriority enums must already exist (created with the issues tables).

-- AlterTable
ALTER TABLE "notes" ADD COLUMN     "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "priority" "IssuePriority" NOT NULL DEFAULT 'MEDIUM',
ADD COLUMN     "status" "IssueStatus" NOT NULL DEFAULT 'TODO';

-- CreateTable
CREATE TABLE "note_criteria" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "note_criteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_comments" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "note_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "note_criteria_noteId_position_idx" ON "note_criteria"("noteId", "position");

-- CreateIndex
CREATE INDEX "note_comments_noteId_createdAt_idx" ON "note_comments"("noteId", "createdAt");

-- CreateIndex
CREATE INDEX "notes_userId_status_idx" ON "notes"("userId", "status");

-- AddForeignKey
ALTER TABLE "note_criteria" ADD CONSTRAINT "note_criteria_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_comments" ADD CONSTRAINT "note_comments_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_comments" ADD CONSTRAINT "note_comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

