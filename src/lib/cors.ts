import { NextRequest, NextResponse } from "next/server";

export const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:5173",
  "https://life-note-r-production.up.railway.app"
];

/**
 * CORS error responses
 */
export const corsErrors = {
  ORIGIN_NOT_ALLOWED: {
    code: "CORS_ORIGIN_NOT_ALLOWED",
    message: "The request origin is not allowed to access this resource",
    status: 403,
  },
  METHOD_NOT_ALLOWED: {
    code: "CORS_METHOD_NOT_ALLOWED",
    message: "The requested HTTP method is not allowed",
    status: 405,
  },
  HEADERS_NOT_ALLOWED: {
    code: "CORS_HEADERS_NOT_ALLOWED",
    message: "Some requested headers are not allowed",
    status: 403,
  },
} as const;

/**
 * Check if origin is allowed
 */
export function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin);
}

/**
 * Handle CORS preflight requests
 */
export function handleCorsPreFlight(
  req: NextRequest,
  allowedMethods: string[] = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]
): NextResponse | null {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    // Preflight request
    if (!isOriginAllowed(origin)) {
      return new NextResponse(JSON.stringify(corsErrors.ORIGIN_NOT_ALLOWED), {
        status: corsErrors.ORIGIN_NOT_ALLOWED.status,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    const requestMethod = req.headers.get("access-control-request-method");
    if (requestMethod && !allowedMethods.includes(requestMethod)) {
      return new NextResponse(JSON.stringify(corsErrors.METHOD_NOT_ALLOWED), {
        status: corsErrors.METHOD_NOT_ALLOWED.status,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    return new NextResponse(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": allowedMethods.join(", "),
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  return null;
}

/**
 * Add CORS headers to response
 */
export function addCorsHeaders(
  response: NextResponse,
  origin: string | null
): NextResponse {
  if (isOriginAllowed(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Credentials", "true");
  }
  return response;
}

/**
 * Create a CORS error response
 */
export function createCorsErrorResponse(
  errorType: keyof typeof corsErrors,
  origin: string | null = null
): NextResponse {
  const error = corsErrors[errorType];
  const response = new NextResponse(JSON.stringify(error), {
    status: error.status,
    headers: {
      "Content-Type": "application/json",
    },
  });

  return addCorsHeaders(response, origin);
}
