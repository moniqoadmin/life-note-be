-- Notes full-text search setup.
--
-- Prisma's `Unsupported("tsvector")` field just gets Prisma to create a plain,
-- unmanaged "searchVector" column on the "notes" table — it does not know how to
-- populate it. Run this ONCE, after the "notes" table exists (i.e. after
-- `prisma db push` or `prisma migrate deploy` has applied the Note model), to turn
-- that column into a Postgres-maintained generated column and index it.
--
-- This is the pattern Postgres's own docs recommend for full-text search columns:
-- https://www.postgresql.org/docs/current/textsearch-tables.html#TEXTSEARCH-TABLES-INDEX
--
-- If this project moves to `prisma migrate`, fold this file's contents into the
-- migration that creates the "notes" table (`prisma migrate dev --create-only`,
-- then paste this in before applying) instead of running it by hand.

BEGIN;

ALTER TABLE "notes" DROP COLUMN IF EXISTS "searchVector";

ALTER TABLE "notes"
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce("title", '') || ' ' || coalesce("content", ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS "notes_searchVector_idx" ON "notes" USING GIN ("searchVector");

COMMIT;

-- Optional further scale-out, once per-user note counts get large: enabling the
-- btree_gin extension lets you build a single combined index on (userId, searchVector)
-- so a search is satisfied by one index instead of a bitmap AND of two:
--
--   CREATE EXTENSION IF NOT EXISTS btree_gin;
--   CREATE INDEX "notes_userId_searchVector_idx" ON "notes" USING GIN ("userId", "searchVector");
--
-- Not applied by default since some managed Postgres providers restrict extensions.
