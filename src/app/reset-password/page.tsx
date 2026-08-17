"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const res = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code, password }),
    });
    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.error ?? "Something went wrong.");
      return;
    }

    router.push("/login");
  }

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold">Reset password</h1>

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
        <label className="text-sm font-medium">Reset code</label>
        <input
          inputMode="numeric"
          maxLength={6}
          className="w-full rounded-md border px-3 py-2 tracking-widest"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          required
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">New password</label>
        <input
          type="password"
          className="w-full rounded-md border px-3 py-2"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <p className="text-xs text-gray-500">
          At least 8 characters, with upper, lower, and a number.
        </p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-md bg-black py-2 text-white disabled:opacity-50"
      >
        {loading ? "Resetting…" : "Reset password"}
      </button>

      <p className="text-sm text-gray-600">
        <Link href="/login" className="underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Suspense fallback={null}>
        <ResetPasswordForm />
      </Suspense>
    </main>
  );
}
