import { NextResponse } from "next/server";
import { signIn } from "@/auth";
import { prisma } from "@/lib/prisma";
import { loginSchema } from "@/lib/validation";
import { parseJsonBody, withApiErrorHandling } from "@/lib/api";
import { runSignIn } from "@/lib/auth-errors";

/**
 * @swagger
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Sign in with email and password
 *     description: JSON alternative to NextAuth's form-based callback. On success sets the session cookie and returns the user; on failure returns the standard `{ error: { code, message } }` body with a matching HTTP status.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Signed in. Session cookie set.
 *       400:
 *         description: Invalid input.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Invalid email or password (code `credentials`).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Email not verified (code `email_not_verified`).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Too many attempts (code `rate_limited`).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export const POST = withApiErrorHandling(async (req: Request) => {
  const parsed = await parseJsonBody(req, loginSchema);
  if (!parsed.success) return parsed.response;

  const failure = await runSignIn(() =>
    signIn("credentials", { ...parsed.data, redirect: false })
  );
  if (failure) return failure;

  // auth() would still read the incoming (pre-login) cookies here, so look
  // the user up directly instead.
  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email.toLowerCase() },
    select: { id: true, email: true, name: true },
  });
  return NextResponse.json({ user });
});
