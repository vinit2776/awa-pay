import { eq } from "drizzle-orm";
import { verifySession } from "@/auth/dal";
import { withGrantScope, UnauthorizedGrantError } from "@/db/runtime";
import { department } from "@/db/schema";
import { CaptureForm } from "./CaptureForm";

export default async function NewRequestPage() {
  const session = await verifySession();

  let departments: { id: string; name: string }[];
  try {
    departments = await withGrantScope(session.userId, "requester", (tx) =>
      tx.select({ id: department.id, name: department.name }).from(department).where(eq(department.active, true)),
    );
  } catch (err) {
    if (err instanceof UnauthorizedGrantError) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <h1 className="text-xl font-semibold">Not permitted</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Your account isn&apos;t set up to raise requests.
          </p>
        </div>
      );
    }
    throw err;
  }

  return (
    <div className="flex flex-1 flex-col items-center gap-6 px-4 py-8">
      <h1 className="text-2xl font-semibold">Raise a request</h1>
      <CaptureForm departments={departments} />
    </div>
  );
}
