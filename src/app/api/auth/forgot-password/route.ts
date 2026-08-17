import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { emailOnlySchema } from "@/lib/validation";
import { issueOtp, OtpCooldownError } from "@/lib/otp";
import { sendPasswordResetOtpEmail } from "@/lib/mail";

const GENERIC_MESSAGE = "If an account exists for this email, a reset code has been sent.";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = emailOnlySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 }
    );
  }

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
      return NextResponse.json(
        { error: "Please wait a bit before requesting another code." },
        { status: 429 }
      );
    }
    throw err;
  }

  return NextResponse.json({ message: GENERIC_MESSAGE });
}
