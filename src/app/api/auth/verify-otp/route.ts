import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { otpSchema } from "@/lib/validation";
import { verifyOtp } from "@/lib/otp";
import { parseJsonBody, withApiErrorHandling, apiError } from "@/lib/api";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/request";

// verifyOtp() already caps guesses at 5 per token (src/lib/otp.ts), but that's
// scoped to one user's active token — without an IP limit too, an attacker
// could still spray guesses across many different email addresses from one
// IP to search for any account with a guessable/leaked code.
const VERIFY_IP_LIMIT = 30;
const VERIFY_IP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/**
 * @swagger
 * /auth/verify-otp:
 *   post:
 *     tags: [Auth]
 *     summary: Verify email OTP
 *     description: Confirms the 6-digit OTP sent to the user's email and marks the account as verified.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, code]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               code:
 *                 type: string
 *                 minLength: 6
 *                 maxLength: 6
 *     responses:
 *       200:
 *         description: Email verified.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Message'
 *       400:
 *         description: Invalid input, or the code is invalid/expired.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Too many attempts from this IP.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export const POST = withApiErrorHandling(async (req: Request) => {
  await enforceRateLimit(`verify-otp:ip:${getClientIp(req)}`, VERIFY_IP_LIMIT, VERIFY_IP_WINDOW_MS);

  const parsed = await parseJsonBody(req, otpSchema);
  if (!parsed.success) return parsed.response;

  const email = parsed.data.email.toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return apiError(400, "Invalid or expired code.", { code: "INVALID_OTP" });
  }

  const result = await verifyOtp(user.id, "EMAIL_VERIFICATION", parsed.data.code);
  if (!result.ok) {
    return apiError(400, "Invalid or expired code.", { code: "INVALID_OTP" });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { emailVerified: new Date() },
  });

  return NextResponse.json({ message: "Email verified. You can now sign in." });
});
