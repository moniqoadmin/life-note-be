import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { emailOnlySchema } from "@/lib/validation";
import { issueOtp, OtpCooldownError } from "@/lib/otp";
import { sendPasswordResetOtpEmail } from "@/lib/mail";
import { parseJsonBody, withApiErrorHandling, apiError } from "@/lib/api";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/request";

const GENERIC_MESSAGE = "If an account exists for this email, a reset code has been sent.";

// Mirrors resend-otp's IP limit: the per-user OTP cooldown alone doesn't stop
// one IP from requesting resets for many different emails.
const FORGOT_PASSWORD_IP_LIMIT = 10;
const FORGOT_PASSWORD_IP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/**
 * @swagger
 * /auth/forgot-password:
 *   post:
 *     tags: [Auth]
 *     summary: Request a password reset OTP
 *     description: Emails a 6-digit password-reset OTP if the account exists. Always returns a generic message to avoid leaking account existence.
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
  await enforceRateLimit(
    `forgot-password:ip:${getClientIp(req)}`,
    FORGOT_PASSWORD_IP_LIMIT,
    FORGOT_PASSWORD_IP_WINDOW_MS
  );

  const parsed = await parseJsonBody(req, emailOnlySchema);
  if (!parsed.success) return parsed.response;

  const email = parsed.data.email.toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    return NextResponse.json({ message: GENERIC_MESSAGE });
  }

  try {
    const code = await issueOtp(user.id, "PASSWORD_RESET");
    await sendPasswordResetOtpEmail(email, code);
  } catch (err) {
    if (err instanceof OtpCooldownError) {
      return apiError(429, "Please wait a bit before requesting another code.", { code: "OTP_COOLDOWN" });
    }
    throw err;
  }

  return NextResponse.json({ message: GENERIC_MESSAGE });
});
