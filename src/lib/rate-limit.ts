import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export class RateLimitError extends Error {
  constructor(public retryAfterMs: number) {
    super("Too many requests. Please try again later.");
  }
}

/**
 * Fixed-window rate limiter backed by a single atomic Postgres upsert
 * (INSERT ... ON CONFLICT DO UPDATE), so it's correct under concurrent
 * requests and across however many serverless/edge instances are running —
 * unlike an in-memory Map, which is per-process and resets on every deploy.
 *
 * `key` should already namespace the thing being limited, e.g.
 * `login:ip:203.0.113.4` or `login:email:foo@example.com`.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
  const now = new Date();
  const windowResetAt = new Date(now.getTime() + windowMs);

  const rows = await prisma.$queryRaw<{ count: number; resetAt: Date }[]>(Prisma.sql`
    INSERT INTO "rate_limit_buckets" ("key", "count", "resetAt")
    VALUES (${key}, 1, ${windowResetAt})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN "rate_limit_buckets"."resetAt" <= ${now} THEN 1
        ELSE "rate_limit_buckets"."count" + 1
      END,
      "resetAt" = CASE
        WHEN "rate_limit_buckets"."resetAt" <= ${now} THEN ${windowResetAt}
        ELSE "rate_limit_buckets"."resetAt"
      END
    RETURNING "count", "resetAt"
  `);

  const row = rows[0];
  return {
    allowed: row.count <= limit,
    remaining: Math.max(0, limit - row.count),
    resetAt: row.resetAt,
  };
}

/**
 * Throws RateLimitError when the limit is exceeded; otherwise resolves.
 * Convenience wrapper for the common "enforce or bail" call site.
 */
export async function enforceRateLimit(key: string, limit: number, windowMs: number) {
  const result = await checkRateLimit(key, limit, windowMs);
  if (!result.allowed) {
    throw new RateLimitError(Math.max(0, result.resetAt.getTime() - Date.now()));
  }
}
