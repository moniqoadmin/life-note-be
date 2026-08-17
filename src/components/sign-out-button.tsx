"use client";

import { signOut } from "next-auth/react";

export function SignOutButton() {
  return (
    <button
      onClick={() => signOut({ callbackUrl: "/login" })}
      className="rounded-md border px-3 py-1.5 text-sm"
    >
      Sign out
    </button>
  );
}
