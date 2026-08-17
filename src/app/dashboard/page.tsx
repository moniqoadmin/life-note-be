import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { SignOutButton } from "@/components/sign-out-button";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  return (
    <main className="flex flex-1 flex-col p-6">
      <div className="mx-auto w-full max-w-lg space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <SignOutButton />
        </div>
        <p className="text-gray-600">
          Signed in as <span className="font-medium">{session.user.email}</span>
        </p>
      </div>
    </main>
  );
}
