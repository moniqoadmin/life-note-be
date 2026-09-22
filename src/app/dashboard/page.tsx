import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { NotesWorkspace } from "@/components/notes-workspace";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  return <NotesWorkspace email={session.user.email ?? ""} />;
}
