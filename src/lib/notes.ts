import { prisma } from "@/lib/prisma";

/**
 * Fetches a note only if it belongs to the given user. Returns null both when the
 * note doesn't exist and when it belongs to someone else — callers should treat both
 * as a 404, never leak which case it was.
 */
export async function getOwnedNote(userId: string, id: string) {
  return prisma.note.findFirst({ where: { id, userId } });
}

/**
 * True if moving `noteId` under `newParentId` would create a cycle — i.e. `newParentId`
 * is `noteId` itself, or is one of `noteId`'s own descendants. Walks upward from
 * `newParentId` toward the root, so cost is bounded by tree depth, not tree size.
 */
export async function wouldCreateCycle(
  userId: string,
  noteId: string,
  newParentId: string
): Promise<boolean> {
  if (noteId === newParentId) return true;

  const rows = await prisma.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE ancestors AS (
      SELECT "id", "parentId" FROM "notes" WHERE "id" = ${newParentId} AND "userId" = ${userId}
      UNION ALL
      SELECT n."id", n."parentId"
      FROM "notes" n
      JOIN ancestors a ON n."id" = a."parentId"
    )
    SELECT "id" FROM ancestors WHERE "id" = ${noteId}
  `;
  return rows.length > 0;
}

export interface NoteSearchHit {
  id: string;
  title: string;
  parentId: string | null;
  updatedAt: Date;
  rank: number;
  snippet: string;
  breadcrumb: { id: string; title: string }[];
}

/**
 * Full-text search over a user's notes, optionally scoped to one note's subtree.
 *
 * Matching relies entirely on the "searchVector" GIN index (see
 * prisma/sql/notes-search-setup.sql) so cost scales with match count, not with total
 * note count. Ancestor breadcrumbs are fetched only for the returned page of hits —
 * a second recursive walk bounded by (page size x tree depth), never a full-table scan.
 */
export async function searchNotes(
  userId: string,
  {
    q,
    rootId,
    limit,
    offset,
  }: { q: string; rootId?: string | null; limit: number; offset: number }
): Promise<{ hits: NoteSearchHit[]; hasMore: boolean }> {
  type Row = {
    id: string;
    title: string;
    parentId: string | null;
    updatedAt: Date;
    rank: number;
    snippet: string;
  };

  const rows = rootId
    ? await prisma.$queryRaw<Row[]>`
        WITH RECURSIVE subtree AS (
          SELECT "id" FROM "notes" WHERE "id" = ${rootId} AND "userId" = ${userId}
          UNION ALL
          SELECT n."id" FROM "notes" n JOIN subtree s ON n."parentId" = s."id"
        )
        SELECT
          n."id",
          n."title",
          n."parentId",
          n."updatedAt",
          ts_rank_cd(n."searchVector", query) AS rank,
          ts_headline('english', n."content", query, 'MaxFragments=1, MaxWords=25, MinWords=5') AS snippet
        FROM "notes" n, websearch_to_tsquery('english', ${q}) query
        WHERE n."userId" = ${userId}
          AND n."id" IN (SELECT "id" FROM subtree)
          AND n."searchVector" @@ query
        ORDER BY rank DESC, n."updatedAt" DESC
        LIMIT ${limit} OFFSET ${offset}
      `
    : await prisma.$queryRaw<Row[]>`
        SELECT
          n."id",
          n."title",
          n."parentId",
          n."updatedAt",
          ts_rank_cd(n."searchVector", query) AS rank,
          ts_headline('english', n."content", query, 'MaxFragments=1, MaxWords=25, MinWords=5') AS snippet
        FROM "notes" n, websearch_to_tsquery('english', ${q}) query
        WHERE n."userId" = ${userId}
          AND n."searchVector" @@ query
        ORDER BY rank DESC, n."updatedAt" DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

  if (rows.length === 0) return { hits: [], hasMore: false };

  const breadcrumbs = await getBreadcrumbs(rows.map((r) => r.id));

  const hits: NoteSearchHit[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    parentId: r.parentId,
    updatedAt: r.updatedAt,
    rank: r.rank,
    snippet: r.snippet,
    breadcrumb: breadcrumbs.get(r.id) ?? [],
  }));

  // We fetched `limit` rows; if we got exactly that many there may be more after this
  // page. Avoids a separate COUNT(*) query on every search request.
  return { hits, hasMore: rows.length === limit };
}

/** Ancestor chain (root-first, excluding the note itself) for each of the given note ids. */
async function getBreadcrumbs(
  noteIds: string[]
): Promise<Map<string, { id: string; title: string }[]>> {
  const rows = await prisma.$queryRaw<
    { noteId: string; id: string; title: string; depth: number }[]
  >`
    WITH RECURSIVE ancestors AS (
      SELECT "id" AS "noteId", "id", "title", "parentId", 0 AS depth
      FROM "notes"
      WHERE "id" = ANY(${noteIds}::text[])
      UNION ALL
      SELECT a."noteId", n."id", n."title", n."parentId", a.depth + 1
      FROM "notes" n
      JOIN ancestors a ON n."id" = a."parentId"
    )
    SELECT "noteId", "id", "title", depth
    FROM ancestors
    WHERE depth > 0
    ORDER BY "noteId", depth DESC
  `;

  const map = new Map<string, { id: string; title: string }[]>();
  for (const row of rows) {
    const list = map.get(row.noteId) ?? [];
    list.push({ id: row.id, title: row.title });
    map.set(row.noteId, list);
  }
  return map;
}
