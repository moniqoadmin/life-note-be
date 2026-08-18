/**
 * Best-effort client IP extraction for rate limiting. Behind a proxy/CDN
 * (Vercel, nginx, etc.) the socket address isn't the real client, so we read
 * the standard forwarding headers instead; `x-forwarded-for` can contain a
 * client-supplied chain, so only the *first* hop set by our own edge/proxy is
 * trustworthy — that's fine here since IP is a rate-limit signal, not an
 * authorization decision.
 */
export function getClientIp(req: Request): string {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  return "unknown";
}
