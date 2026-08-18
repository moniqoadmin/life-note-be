import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { emailOnlySchema } from "@/lib/validation";
import { issueOtp, OtpCooldownError } from "@/lib/otp";
import { sendVerificationOtpEmail } from "@/lib/mail";
import { parseJsonBody, withApiErrorHandling } from "@/lib/api";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/request";

const GENERIC_MESSAGE = "If an account exists and is unverified, a new code has been sent.";

// The per-user 60s OTP cooldown (src/lib/otp.ts) doesn't stop one IP from
// cycling through many *different* target emails; this caps that separately.
const RESEND_IP_LIMIT = 10;
const RESEND_IP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/**
 * @swagger
 * /auth/resend-otp:
 *   post:
 *     tags: [Auth]
 *     summary: Resend email verification OTP
 *     description: Sends a new email-verification OTP if the account exists and is not yet verified. Always returns a generic message to avoid leaking account existence.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: Generic confirmation message.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Message'
 *       400:
 *         description: Invalid input.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: A code was already sent recently, or too many requests from this IP; please wait before retrying.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export const POST = withApiErrorHandling(async (req: Request) => {
  await enforceRateLimit(`resend-otp:ip:${getClientIp(req)}`, RESEND_IP_LIMIT, RESEND_IP_WINDOW_MS);

  const parsed = await parseJsonBody(req, emailOnlySchema);
  if (!parsed.success) return parsed.response;

  const email = parsed.data.email.toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || user.emailVerified) {
    return NextResponse.json({ message: GENERIC_MESSAGE });
  }

  try {
    const code = await issueOtp(user.id, "EMAIL_VERIFICATION");
    await sendVerificationOtpEmail(email, code);
  } catch (err) {
    if (err instanceof OtpCooldownError) {
      return NextResponse.json(
        { error: "Please wait a bit before requesting another code." },
        { status: 429 }
      );
    }
    throw err;
  }

  return NextResponse.json({ message: GENERIC_MESSAGE });
});
