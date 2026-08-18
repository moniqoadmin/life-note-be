import { z } from "zod";

// Fail fast at boot if a required secret/config value is missing or malformed,
// instead of failing later (and confusingly) the first time it's used —
// e.g. NextAuth throwing deep in a request when AUTH_SECRET is unset, or
// nodemailer silently no-op'ing with an empty SMTP_HOST.
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  AUTH_SECRET: z
    .string()
    .min(32, "AUTH_SECRET must be at least 32 characters (openssl rand -base64 32)"),
  SMTP_HOST: z.string().min(1, "SMTP_HOST is required"),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  SMTP_USER: z.string().min(1, "SMTP_USER is required"),
  SMTP_PASSWORD: z.string().min(1, "SMTP_PASSWORD is required"),
  SMTP_FROM: z.string().min(1, "SMTP_FROM is required"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(
      `Invalid or missing environment variables:\n${issues}\n\nSee .env.example for the full list.`
    );
  }
  return parsed.data;
}

// Skip strict validation during `next build`/lint on CI where env vars may not
// be provided yet (Next.js still statically analyzes route files at build time)
// — only enforce this at actual runtime.
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

export const env = isBuildPhase
  ? (process.env as unknown as z.infer<typeof envSchema>)
  : loadEnv();
