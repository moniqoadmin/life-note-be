import { CredentialsSignin } from "next-auth";
import { apiError } from "@/lib/api";

// NextAuth reports sign-in failures as `?error=CredentialsSignin&code=<code>`
// redirect URLs (or thrown CredentialsSignin errors from server-side
// signIn()). These map those codes onto the API's standard error body so
// JSON clients don't have to parse NextAuth URLs.
const SIGN_IN_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  credentials: { status: 401, code: "INVALID_CREDENTIALS", message: "Invalid email or password." },
  email_not_verified: {
    status: 403,
    code: "EMAIL_NOT_VERIFIED",
    message: "Please verify your email before signing in.",
  },
  rate_limited: {
    status: 429,
    code: "RATE_LIMITED",
    message: "Too many sign-in attempts. Please try again later.",
  },
};

export function signInErrorResponse(nextAuthCode: string) {
  const { status, code, message } = SIGN_IN_ERRORS[nextAuthCode] ?? SIGN_IN_ERRORS.credentials;
  return apiError(status, message, { code });
}

/**
 * Runs a server-side signIn() call and returns an error response if it
 * failed, or null on success. Handles both ways NextAuth can report failure:
 * a thrown error, or a returned URL carrying `error`/`code` params.
 */
export async function runSignIn(attempt: () => Promise<string>) {
  try {
    const url = new URL(await attempt(), "http://localhost");
    const error = url.searchParams.get("error");
    if (!error) return null;
    if (error === "CredentialsSignin") {
      return signInErrorResponse(url.searchParams.get("code") ?? "credentials");
    }
    throw new Error(`Sign-in failed: ${error}`);
  } catch (err) {
    if (err instanceof CredentialsSignin) return signInErrorResponse(err.code);
    // Anything else (DB down, misconfiguration) is a server error, not a
    // wrong password — let withApiErrorHandling turn it into a 500.
    throw err;
  }
}
