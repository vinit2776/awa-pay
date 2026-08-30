import { redirect } from "next/navigation";
import { getPendingSession } from "@/auth/session";
import { MfaForm } from "./MfaForm";

export default async function MfaPage() {
  const pending = await getPendingSession();
  if (!pending) {
    redirect("/login");
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 px-4">
      <h1 className="text-2xl font-semibold">Enter your authentication code</h1>
      <MfaForm />
    </div>
  );
}
