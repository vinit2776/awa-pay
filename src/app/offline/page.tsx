// The service worker's own navigation fallback (public/sw.js) — deliberately
// static, no session, no data fetch. AGENTS.md rule 2: a shared plant or
// office device means the next person to open the app is someone else, so
// the only thing allowed to survive a failed navigation is a generic page
// that says nothing about who was here before. Outside the (app) route
// group on purpose — it must render with no session at all.
export default function OfflinePage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-10">
      <div className="flex max-w-sm flex-col gap-2 rounded-xl border border-warn-line bg-warn-soft p-5">
        <h1 className="text-lg font-semibold text-warn">You&apos;re offline</h1>
        <p className="text-sm text-ink">
          This page needs a connection. If you were capturing a bill, it&apos;s been saved on this device and will send itself once you&apos;re back on signal.
        </p>
      </div>
    </div>
  );
}
