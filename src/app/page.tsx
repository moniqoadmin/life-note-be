import Link from "next/link";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-3xl font-semibold">Core App</h1>
      <div className="flex gap-3">
        <Link href="/login" className="rounded-md bg-black px-4 py-2 text-white">
          Sign in
        </Link>
        <Link href="/register" className="rounded-md border px-4 py-2">
          Sign up
        </Link>
      </div>
    </main>
  );
}
