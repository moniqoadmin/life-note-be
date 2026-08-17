import crypto from "crypto";
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

export async function issueOtp(userId: string, purpose: OtpPurpose) {
  const lastToken = await prisma.otpToken.findFirst({
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
  await prisma.otpToken.updateMany({
    where: { userId, purpose, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  const code = generateCode();
  await prisma.otpToken.create({
    data: {
      userId,
      purpose,
      codeHash: hashCode(code),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    },
  });

  return code;
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
    await prisma.otpToken.update({
      where: { id: token.id },
      data: { attempts: { increment: 1 } },
    });
    return { ok: false, reason: "invalid_code" };
  }

  await prisma.otpToken.update({
    where: { id: token.id },
    data: { consumedAt: new Date() },
  });

  return { ok: true };
}
