import { NextResponse } from "next/server";
import type { z } from "zod";
import { Prisma } from "@prisma/client";
import { RateLimitError } from "@/lib/rate-limit";

// Standard error body for every API route:
//   { "error": { "code": "NOT_FOUND", "message": "Issue not found", "details"?: [...] } }
// `code` is stable and machine-readable (clients branch on it); `message` is
// human-readable and may change; `details` carries per-field validation issues.
export type ApiErrorDetail = { path: string; message: string };
export type ApiErrorBody = {
  error: { code: string; message: string; details?: ApiErrorDetail[] };
};

const DEFAULT_ERROR_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  429: "RATE_LIMITED",
  500: "INTERNAL_ERROR",
};

export function apiError(
  status: number,
  message: string,
  options: { code?: string; details?: ApiErrorDetail[]; headers?: HeadersInit } = {}
): NextResponse<ApiErrorBody> {
  const code = options.code ?? DEFAULT_ERROR_CODES[status] ?? "ERROR";
  return NextResponse.json(
    { error: { code, message, ...(options.details && { details: options.details }) } },
    { status, headers: options.headers }
  );
}

/** 400 VALIDATION_ERROR with every zod issue listed in `details`. */
export function validationError(error: z.ZodError): NextResponse<ApiErrorBody> {
  return apiError(400, error.issues[0]?.message ?? "Invalid input", {
    code: "VALIDATION_ERROR",
    details: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}

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
    return { success: false, response: validationError(parsed.error) };
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
        return apiError(429, "Too many requests. Please try again later.", {
          headers: { "Retry-After": String(Math.ceil(err.retryAfterMs / 1000)) },
        });
      }

      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return apiError(409, "A record with these details already exists.");
      }

      console.error("Unhandled API error:", err);
      return apiError(500, "Something went wrong. Please try again.");
    }
  };
}
