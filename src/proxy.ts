import { NextResponse } from "next/server";
import { auth } from "@/auth";

const PROTECTED_PREFIXES = ["/dashboard"];

// Any origin is allowed. We echo the request's Origin back (instead of "*")
// so credentialed requests (session cookies) are accepted by the browser.
function corsHeaders(origin: string | null, requestHeaders: string | null) {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      requestHeaders ?? "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export default auth((req) => {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith("/api")) {
    const headers = corsHeaders(
      req.headers.get("origin"),
      req.headers.get("access-control-request-headers")
    );

    // Answer preflight requests directly.
    if (req.method === "OPTIONS") {
      return new NextResponse(null, { status: 204, headers });
    }

    const response = NextResponse.next();
    Object.entries(headers).forEach(([key, value]) =>
      response.headers.set(key, value)
    );
    return response;
  }

  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));

  if (isProtected && !req.auth) {
    const loginUrl = new URL("/login", req.nextUrl.origin);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/dashboard/:path*", "/api/:path*"],
};
