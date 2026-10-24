import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { verifyActiveSession, type CurrentSession } from "./session";
import { loadViewer } from "./viewer";

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

// The signed-in person plus the roles they hold — one transaction, memoized
// per request. Prefer this over reading the user and their grants
// separately.
export const getViewer = cache(async () => {
  const session = await verifySession();
  return loadViewer(session.userId);
});

export const getCurrentUser = cache(async () => (await getViewer())?.user ?? null);
