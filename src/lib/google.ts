import { OAuth2Client } from "google-auth-library";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";

const client = new OAuth2Client();

export type GoogleProfile = {
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
};

/**
 * Verifies a Google ID token (signature, expiry, issuer, audience) and returns
 * the profile. Returns null for anything invalid, including unverified emails.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleProfile | null> {
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    if (!p?.sub || !p.email || !p.email_verified) return null;
    return { sub: p.sub, email: p.email.toLowerCase(), name: p.name ?? null, picture: p.picture ?? null };
  } catch {
    return null;
  }
}

/**
 * Finds or creates the local user for a Google profile.
 *  - Known Google account → that user.
 *  - Existing user with the same (Google-verified) email → link the account.
 *    If that local account was never email-verified, its password is dropped:
 *    otherwise whoever pre-registered the address could keep signing in with
 *    the password they set, after the real owner claimed it via Google.
 *  - Otherwise → create a password-less, verified user.
 */
export async function findOrCreateGoogleUser(profile: GoogleProfile) {
  const linked = await prisma.account.findUnique({
    where: { provider_providerAccountId: { provider: "google", providerAccountId: profile.sub } },
    include: { user: true },
  });
  if (linked) return linked.user;

  const accountData = { type: "oidc", provider: "google", providerAccountId: profile.sub };

  const existing = await prisma.user.findUnique({ where: { email: profile.email } });
  if (existing) {
    return prisma.user.update({
      where: { id: existing.id },
      data: {
        ...(existing.emailVerified ? {} : { emailVerified: new Date(), passwordHash: null }),
        image: existing.image ?? profile.picture,
        name: existing.name ?? profile.name,
        accounts: { create: accountData },
      },
    });
  }

  return prisma.user.create({
    data: {
      email: profile.email,
      name: profile.name,
      image: profile.picture,
      emailVerified: new Date(),
      accounts: { create: accountData },
    },
  });
}
