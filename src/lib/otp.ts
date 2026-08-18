import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { OtpPurpose } from "@prisma/client";

const OTP_LENGTH = 6;
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds
const MAX_ATTEMPTS = 5;

function generateCode(): string {
  const max = 10 ** OTP_LENGTH;
  const n = crypto.randomInt(0, max);
  return n.toString().padStart(OTP_LENGTH, "0");
}

function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

export class OtpCooldownError extends Error {
  constructor(public retryAfterMs: number) {
    super("Please wait before requesting another code.");
  }
}

export async function issueOtp(userId: string, purpose: OtpPurpose): Promise<string> {
  const code = generateCode();
  const codeHash = hashCode(code);

  // Cooldown-check, invalidate-old, create-new must be atomic: two concurrent
  // resend requests could otherwise both read "no recent token" and each
  // create one, bypassing the cooldown. Serializable isolation makes Postgres
  // abort one of the two with a serialization failure instead, which we retry
  // once (retrying indefinitely would defeat the cooldown it's protecting).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await prisma.$transaction(
        async (tx) => {
          const lastToken = await tx.otpToken.findFirst({
            where: { userId, purpose },
            orderBy: { createdAt: "desc" },
          });

          if (lastToken) {
            const elapsed = Date.now() - lastToken.createdAt.getTime();
            if (elapsed < RESEND_COOLDOWN_MS) {
              throw new OtpCooldownError(RESEND_COOLDOWN_MS - elapsed);
            }
          }

          // Invalidate any still-active tokens for this purpose.
          await tx.otpToken.updateMany({
            where: { userId, purpose, consumedAt: null },
            data: { consumedAt: new Date() },
          });

          await tx.otpToken.create({
            data: {
              userId,
              purpose,
              codeHash,
              expiresAt: new Date(Date.now() + OTP_TTL_MS),
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
      return code;
    } catch (err) {
      const isSerializationFailure =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034";
      if (isSerializationFailure && attempt === 0) continue;
      throw err;
    }
  }

  // Unreachable, but keeps TypeScript's control-flow analysis happy.
  throw new Error("Failed to issue OTP after retry");
}

type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "expired" | "too_many_attempts" | "invalid_code" };

export async function verifyOtp(
  userId: string,
  purpose: OtpPurpose,
  code: string
): Promise<VerifyResult> {
  const token = await prisma.otpToken.findFirst({
    where: { userId, purpose, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!token) return { ok: false, reason: "not_found" };

  if (token.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }

  if (token.attempts >= MAX_ATTEMPTS) {
    return { ok: false, reason: "too_many_attempts" };
  }

  if (token.codeHash !== hashCode(code)) {
    // Conditional on attempts still being below the cap at write time, so
    // concurrent guesses against the same token can't each read attempts <
    // MAX_ATTEMPTS and all increment past it (a blind `update` would race).
    await prisma.otpToken.updateMany({
      where: { id: token.id, attempts: { lt: MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    return { ok: false, reason: "invalid_code" };
  }

  // Conditional on not already consumed, so a concurrent duplicate request
  // (e.g. a double-submitted form) can't both report success.
  const consumed = await prisma.otpToken.updateMany({
    where: { id: token.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count === 0) {
    return { ok: false, reason: "not_found" };
  }

  return { ok: true };
}
