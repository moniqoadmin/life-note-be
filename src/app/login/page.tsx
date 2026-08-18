"use client";

import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const justVerified = searchParams.get("verified") === "1";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const res = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    setLoading(false);

    if (!res || res.error) {
      // NextAuth reports the generic error type ("CredentialsSignin") in
      // `res.error`; the specific reason travels in `res.code` instead (see
      // the EmailNotVerifiedSignin/RateLimitedSignin classes in src/auth.ts).
      if (res?.code === "email_not_verified") {
        router.push(`/verify-email?email=${encodeURIComponent(email)}`);
        return;
      }
      if (res?.code === "rate_limited") {
        setError("Too many sign-in attempts. Please wait a bit and try again.");
        return;
      }
      setError("Invalid email or password.");
      return;
    }

    router.push("/dashboard");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold">Sign in</h1>

      {justVerified && (
        <p className="text-sm text-green-600">Email verified — you can sign in now.</p>
      )}

      <div className="space-y-1">
        <label className="text-sm font-medium">Email</label>
        <input
          type="email"
          className="w-full rounded-md border px-3 py-2"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium">Password</label>
          <Link href="/forgot-password" className="text-sm underline">
            Forgot password?
          </Link>
        </div>
        <input
          type="password"
          className="w-full rounded-md border px-3 py-2"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-md bg-black py-2 text-white disabled:opacity-50"
      >
        {loading ? "Signing in…" : "Sign in"}
      </button>

      <p className="text-sm text-gray-600">
        Don&apos;t have an account?{" "}
        <Link href="/register" className="underline">
          Sign up
        </Link>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
