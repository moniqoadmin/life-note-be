import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
  },
});

async function sendMail(to: string, subject: string, html: string) {
  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject,
    html,
  });
}

function otpEmailHtml(title: string, intro: string, code: string) {
  return `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2>${title}</h2>
      <p>${intro}</p>
      <p style="font-size: 32px; font-weight: bold; letter-spacing: 8px; margin: 24px 0;">${code}</p>
      <p>This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
    </div>
  `;
}

export async function sendVerificationOtpEmail(to: string, code: string) {
  await sendMail(
    to,
    "Verify your email",
    otpEmailHtml("Verify your email", "Use the code below to verify your email address:", code)
  );
}

export async function sendPasswordResetOtpEmail(to: string, code: string) {
  await sendMail(
    to,
    "Reset your password",
    otpEmailHtml("Reset your password", "Use the code below to reset your password:", code)
  );
}
