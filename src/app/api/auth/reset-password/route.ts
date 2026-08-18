import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resetPasswordSchema } from "@/lib/validation";
import { verifyOtp } from "@/lib/otp";
import { hashPassword } from "@/lib/password";
import { parseJsonBody, withApiErrorHandling } from "@/lib/api";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/request";

// Same rationale as verify-otp: per-token attempt caps aren't enough on their
// own without an IP-wide limit across different target emails.
const RESET_IP_LIMIT = 30;
const RESET_IP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/**
 * @swagger
 * /auth/reset-password:
 *   post:
 *     tags: [Auth]
 *     summary: Reset password
 *     description: Verifies the password-reset OTP and updates the account's password.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, code, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               code:
 *                 type: string
 *                 minLength: 6
 *                 maxLength: 6
 *               password:
 *                 type: string
 *                 description: Min 8 chars, must include a lowercase letter, an uppercase letter, and a number.
 *     responses:
 *       200:
 *         description: Password updated.
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
  await enforceRateLimit(`reset-password:ip:${getClientIp(req)}`, RESET_IP_LIMIT, RESET_IP_WINDOW_MS);

  const parsed = await parseJsonBody(req, resetPasswordSchema);
  if (!parsed.success) return parsed.response;

  const email = parsed.data.email.toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return NextResponse.json({ error: "Invalid or expired code." }, { status: 400 });
  }

  const result = await verifyOtp(user.id, "PASSWORD_RESET", parsed.data.code);
  if (!result.ok) {
    return NextResponse.json({ error: "Invalid or expired code." }, { status: 400 });
  }

  const passwordHash = await hashPassword(parsed.data.password);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash },
  });

  return NextResponse.json({ message: "Password updated. You can now sign in." });
});
