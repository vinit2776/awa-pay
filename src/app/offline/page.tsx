// The service worker's own navigation fallback (public/sw.js) — deliberately
// static, no session, no data fetch. AGENTS.md rule 2: a shared plant or
// office device means the next person to open the app is someone else, so
// the only thing allowed to survive a failed navigation is a generic page
// that says nothing about who was here before. Outside the (app) route
// group on purpose — it must render with no session at all.
export default function OfflinePage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center">
      <h1 className="text-xl font-semibold">You&apos;re offline</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        This page needs a connection. If you were capturing a bill, it&apos;s been saved and will send itself once you&apos;re back on signal.
      </p>
    </div>
  );
}
