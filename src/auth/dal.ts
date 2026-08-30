import "server-only";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { cache } from "react";
import { withActorScope } from "@/db/runtime";
import { user } from "@/db/schema";
import { verifyActiveSession, type CurrentSession } from "./session";

// The real, DB-backed check — called from Server Components/Actions/Route
// Handlers, never from src/proxy.ts (which only does the cheap, optimistic
// cookie-signature check). Memoized per request via React's cache(), per
// Next's Data Access Layer guide.
export const verifySession = cache(async (): Promise<CurrentSession> => {
  const current = await verifyActiveSession();
  if (!current) {
    redirect("/login");
  }
  return current;
});

export const getCurrentUser = cache(async () => {
  const session = await verifySession();

  const [row] = await withActorScope(session.userId, (tx) =>
    tx
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        status: user.status,
        mfaEnrolled: user.mfaEnrolled,
      })
      .from(user)
      .where(eq(user.id, session.userId))
      .limit(1),
  );

  return row ?? null;
});
