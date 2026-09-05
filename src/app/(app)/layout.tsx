import { verifySession } from "@/auth/dal";
import { DraftFlusher } from "@/capture/DraftFlusher";

// The real, DB-backed auth gate — src/proxy.ts only does a cheap cookie
// check. verifySession() is memoized per request (React cache()), so
// nested pages/Server Actions calling it again don't re-query.
export default async function AppLayout({ children }: LayoutProps<"/">) {
  await verifySession();
  return (
    <>
      <DraftFlusher />
      {children}
    </>
  );
}
