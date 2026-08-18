import { NextResponse } from "next/server";
import type { z } from "zod";
import { Prisma } from "@prisma/client";
import { RateLimitError } from "@/lib/rate-limit";

type ParsedBody<T> = { success: true; data: T } | { success: false; response: NextResponse };

/**
 * Parses a request body as JSON and validates it against `schema`, replacing
 * the `req.json().catch(...) + schema.safeParse(...) + 400 response` block
 * that was duplicated verbatim across every auth route.
 *
 * Usage:
 *   const parsed = await parseJsonBody(req, someSchema);
 *   if (!parsed.success) return parsed.response;
 *   const { email } = parsed.data;
 */
export async function parseJsonBody<T>(req: Request, schema: z.ZodType<T>): Promise<ParsedBody<T>> {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      success: false,
      response: NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid input" },
        { status: 400 }
      ),
    };
  }
  return { success: true, data: parsed.data };
}

/**
 * Wraps a route handler so that:
 *  - RateLimitError becomes a 429 with a Retry-After header instead of an
 *    unhandled throw.
 *  - A unique-constraint race (P2002 — e.g. two concurrent signups for the
 *    same brand-new email both passing the pre-check) becomes a clean 409
 *    instead of Next's default 500 page, which in dev leaks a raw Prisma
 *    error message/stack to the client.
 *  - Any other unexpected error is logged server-side and returned as a
 *    generic 500, never forwarding internal error details to the caller.
 */
export function withApiErrorHandling(handler: (req: Request) => Promise<NextResponse>) {
  return async (req: Request): Promise<NextResponse> => {
    try {
      return await handler(req);
    } catch (err) {
      if (err instanceof RateLimitError) {
        return NextResponse.json(
          { error: "Too many requests. Please try again later." },
          {
            status: 429,
            headers: { "Retry-After": String(Math.ceil(err.retryAfterMs / 1000)) },
          }
        );
      }

      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return NextResponse.json(
          { error: "A record with these details already exists." },
          { status: 409 }
        );
      }

      console.error("Unhandled API error:", err);
      return NextResponse.json(
        { error: "Something went wrong. Please try again." },
        { status: 500 }
      );
    }
  };
}
