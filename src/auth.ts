import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";
import { loginSchema } from "@/lib/validation";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/request";
import { env } from "@/lib/env";
import { findOrCreateGoogleUser, verifyGoogleIdToken } from "@/lib/google";

// Login has no natural per-user lockout the way OTP does, so it's rate
// limited on two independent axes:
//  - per IP: caps how fast one attacker can grind through many accounts.
//  - per email: caps how fast one account can be brute-forced, even from a
//    botnet spreading requests across many IPs.
const LOGIN_IP_LIMIT = 20;
const LOGIN_IP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const LOGIN_EMAIL_LIMIT = 5;
const LOGIN_EMAIL_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// NextAuth only ever surfaces `error: "CredentialsSignin"` to the client from
// a thrown plain Error — the distinguishing detail has to travel via the
// `code` field, which only a *subclass* of CredentialsSignin populates (see
// node_modules/@auth/core/errors.js: `type` is fixed per-class, `code` is the
// customizable bit). The previous code threw plain `Error("EMAIL_NOT_VERIFIED")`
// and the login page compared against `res.error`, which silently never
// matched in production — it always resolved to the generic "Invalid email or
// password" branch instead of redirecting to email verification.
export class EmailNotVerifiedSignin extends CredentialsSignin {
  code = "email_not_verified";
}
export class RateLimitedSignin extends CredentialsSignin {
  code = "rate_limited";
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  secret: env.AUTH_SECRET,
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (credentials, request) => {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const email = parsed.data.email.toLowerCase();
        const { password } = parsed.data;
        const ip = getClientIp(request);

        // Count this attempt against both limits up front, before the
        // user lookup and bcrypt compare, so a locked-out caller doesn't get
        // to spend our CPU/DB budget on every request anyway.
        const [ipStatus, emailStatus] = await Promise.all([
          checkRateLimit(`login:ip:${ip}`, LOGIN_IP_LIMIT, LOGIN_IP_WINDOW_MS),
          checkRateLimit(`login:email:${email}`, LOGIN_EMAIL_LIMIT, LOGIN_EMAIL_WINDOW_MS),
        ]);
        if (!ipStatus.allowed || !emailStatus.allowed) {
          throw new RateLimitedSignin();
        }

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) return null;

        const isValid = await verifyPassword(password, user.passwordHash);
        if (!isValid) return null;

        if (!user.emailVerified) {
          throw new EmailNotVerifiedSignin();
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
        };
      },
    }),
    // Google sign-in: the SPA obtains an ID token via Google Identity Services
    // and posts it here; we verify it server-side and issue the normal session
    // cookie, so Google and password logins share one session mechanism.
    Credentials({
      id: "google",
      name: "Google",
      credentials: { idToken: { type: "text" } },
      authorize: async (credentials, request) => {
        const idToken = typeof credentials?.idToken === "string" ? credentials.idToken : "";
        if (!idToken) return null;

        const ipStatus = await checkRateLimit(
          `login:google:ip:${getClientIp(request)}`,
          LOGIN_IP_LIMIT,
          LOGIN_IP_WINDOW_MS
        );
        if (!ipStatus.allowed) throw new RateLimitedSignin();

        const profile = await verifyGoogleIdToken(idToken);
        if (!profile) return null;

        const user = await findOrCreateGoogleUser(profile);
        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
      }
      return session;
    },
  },
});
