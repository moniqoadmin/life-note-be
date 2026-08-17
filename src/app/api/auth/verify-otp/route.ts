import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { otpSchema } from "@/lib/validation";
import { verifyOtp } from "@/lib/otp";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = otpSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 }
    );
  }

  const email = parsed.data.email.toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return NextResponse.json({ error: "Invalid or expired code." }, { status: 400 });
  }

  const result = await verifyOtp(user.id, "EMAIL_VERIFICATION", parsed.data.code);
  if (!result.ok) {
    return NextResponse.json({ error: "Invalid or expired code." }, { status: 400 });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { emailVerified: new Date() },
  });

  return NextResponse.json({ message: "Email verified. You can now sign in." });
}
