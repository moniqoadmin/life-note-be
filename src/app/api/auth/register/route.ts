import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { registerSchema } from "@/lib/validation";
// OTP email verification temporarily disabled.
// import { issueOtp, OtpCooldownError } from "@/lib/otp";
// import { sendVerificationOtpEmail } from "@/lib/mail";
import { hashPassword } from "@/lib/password";
import { parseJsonBody, withApiErrorHandling } from "@/lib/api";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/request";

const REGISTER_IP_LIMIT = 10;
const REGISTER_IP_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Same generic message regardless of whether the account already existed and
// was verified, already existed and was unverified, or is brand new — so the
// response itself can't be used to enumerate which emails have accounts.
// (Previously this returned 409 only for verified accounts, letting a caller
// distinguish "verified account exists" from "no account / unverified".)
// const GENERIC_MESSAGE = "Check your email to finish setting up your account.";
const GENERIC_MESSAGE = "Account created. You can now sign in.";

/**
 * @swagger
 * /auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Create an account
 *     description: Creates a new user account (or re-registers an unverified one) and emails a 6-digit OTP for email verification. Always returns a generic message, whether or not an account already existed, to avoid leaking account existence.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, password]
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 100
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 description: Min 8 chars, must include a lowercase letter, an uppercase letter, and a number.
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
 *         description: Too many registration attempts from this IP.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export const POST = withApiErrorHandling(async (req: Request) => {
  await enforceRateLimit(`register:ip:${getClientIp(req)}`, REGISTER_IP_LIMIT, REGISTER_IP_WINDOW_MS);

  const parsed = await parseJsonBody(req, registerSchema);
  if (!parsed.success) return parsed.response;

  const { name, password } = parsed.data;
  const email = parsed.data.email.toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email } });

  // With OTP disabled, never overwrite an existing account's password from
  // an unauthenticated request — any existing user is treated as a duplicate.
  if (existing) {
    // Do the same amount of work (hash cost, roughly) as the real path so
    // response timing doesn't distinguish this branch either, then return
    // the identical generic message.
    await hashPassword(password);
    return NextResponse.json({ message: GENERIC_MESSAGE });
  }

  const passwordHash = await hashPassword(password);

  // Race on brand-new email is turned into a clean 409 by withApiErrorHandling (P2002).
  await prisma.user.create({
    data: { name, email, passwordHash, emailVerified: new Date() },
  });

  // OTP email verification temporarily disabled:
  // const user = existing
  //   ? await prisma.user.update({ where: { id: existing.id }, data: { name, passwordHash } })
  //   : await prisma.user.create({ data: { name, email, passwordHash } });
  // try {
  //   const code = await issueOtp(user.id, "EMAIL_VERIFICATION");
  //   await sendVerificationOtpEmail(email, code);
  // } catch (err) {
  //   if (err instanceof OtpCooldownError) {
  //     return NextResponse.json({ message: GENERIC_MESSAGE });
  //   }
  //   throw err;
  // }

  return NextResponse.json({ message: GENERIC_MESSAGE });
});
