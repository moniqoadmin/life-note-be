import { NextResponse } from "next/server";
import { auth } from "@/auth";

const PROTECTED_PREFIXES = ["/dashboard"];

export default auth((req) => {
  const isProtected = PROTECTED_PREFIXES.some((p) =>
    req.nextUrl.pathname.startsWith(p)
  );

  if (isProtected && !req.auth) {
    const loginUrl = new URL("/login", req.nextUrl.origin);
    loginUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/dashboard/:path*"],
};
