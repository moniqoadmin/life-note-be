import nodemailer from "nodemailer";
import { env } from "@/lib/env";
import type { PendingEmail } from "@/lib/notifications";

const transporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_SECURE,
  auth: {
    user: env.SMTP_USER,
    pass: env.SMTP_PASSWORD,
  },
});

async function sendMail(to: string, subject: string, html: string) {
  await transporter.sendMail({
    from: env.SMTP_FROM,
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

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendNotificationEmail({ to, type, actorName, issue, excerpt }: PendingEmail) {
  const action = type === "MENTION" ? "mentioned you on" : "assigned you to";
  const subject = `[${issue.key}] ${actorName} ${action} ${issue.title}`;
  const link = env.APP_URL
    ? `${env.APP_URL.replace(/\/$/, "")}/issues/${encodeURIComponent(issue.id)}`
    : null;

  await sendMail(
    to,
    subject,
    `
    <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto;">
      <p><strong>${escapeHtml(actorName)}</strong> ${action}
        <strong>${escapeHtml(issue.key)}</strong>: ${escapeHtml(issue.title)}</p>
      ${excerpt ? `<blockquote style="border-left: 3px solid #ccc; margin: 16px 0; padding-left: 12px; color: #444;">${escapeHtml(excerpt)}</blockquote>` : ""}
      ${link ? `<p><a href="${escapeHtml(link)}">Open ${escapeHtml(issue.key)}</a></p>` : ""}
    </div>
  `
  );
}
