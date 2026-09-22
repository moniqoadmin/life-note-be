"use client";

import { signOut } from "next-auth/react";

// The login UI lives in the separate SPA; fall back to this app's /login if unset.
const LOGIN_URL = process.env.NEXT_PUBLIC_FRONTEND_URL
  ? `${process.env.NEXT_PUBLIC_FRONTEND_URL}/login`
  : "/login";

export function SignOutButton() {
  return (
    <button
      onClick={async () => {
        await signOut({ redirect: false });
        window.location.assign(LOGIN_URL);
      }}
      className="rounded-md border px-3 py-1.5 text-sm"
    >
      Sign out
    </button>
  );
}
