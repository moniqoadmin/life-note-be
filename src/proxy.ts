import { NextResponse } from "next/server";
import { auth } from "@/auth";

const PROTECTED_PREFIXES = ["/dashboard"];

// CORS for /api/*. The SPA sends credentialed requests (cookies), and browsers
// reject `Access-Control-Allow-Origin: *` for those, so instead of "*" we echo
// back whatever Origin made the request — i.e. all origins are allowed.
function withCors(req: Request, res: NextResponse) {
  const origin = req.headers.get("origin");
  if (origin) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Access-Control-Allow-Credentials", "true");
    res.headers.append("Vary", "Origin");
  }
  res.headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.headers.set(
    "Access-Control-Allow-Headers",
    req.headers.get("access-control-request-headers") ?? "Content-Type, Authorization, X-Auth-Return-Redirect"
  );
  res.headers.set("Access-Control-Max-Age", "86400");
  return res;
}

export default auth((req) => {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith("/api/")) {
    if (req.method === "OPTIONS") {
      return withCors(req, new NextResponse(null, { status: 204 }));
    }
    return withCors(req, NextResponse.next());
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
