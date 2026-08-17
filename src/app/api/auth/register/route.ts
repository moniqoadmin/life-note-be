import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { registerSchema } from "@/lib/validation";
import { issueOtp, OtpCooldownError } from "@/lib/otp";
import { sendVerificationOtpEmail } from "@/lib/mail";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 }
    );
  }

  const { name, password } = parsed.data;
  const email = parsed.data.email.toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing && existing.emailVerified) {
    return NextResponse.json(
      { error: "An account with this email already exists." },
      { status: 409 }
    );
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: { name, passwordHash },
      })
    : await prisma.user.create({
        data: { name, email, passwordHash },
      });

  try {
    const code = await issueOtp(user.id, "EMAIL_VERIFICATION");
    await sendVerificationOtpEmail(email, code);
  } catch (err) {
    if (err instanceof OtpCooldownError) {
      return NextResponse.json(
        { message: "Account created. A verification code was already sent recently." },
        { status: 200 }
      );
    }
    throw err;
  }

  return NextResponse.json({
    message: "Account created. Check your email for a verification code.",
  });
}
