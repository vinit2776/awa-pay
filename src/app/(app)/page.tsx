import Link from "next/link";
import { getShellContext } from "@/ui/shell/context";
import { buttonClass, eyebrowClass } from "@/ui/styles";

// Greeting and date in India time, whatever the server's clock is set to.
function greeting(now: Date): string {
  const hour = Number(new Intl.DateTimeFormat("en-IN", { hour: "numeric", hourCycle: "h23", timeZone: "Asia/Kolkata" }).format(now));
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

type Tile = { href: string; label: string; count: number | undefined; empty: string };

export default async function Home() {
  const ctx = await getShellContext();
  if (!ctx) return null;
  const { user, roles, counts } = ctx;
  const now = new Date();

  const tiles: Tile[] = [];
  if (roles.has("requester")) tiles.push({ href: "/requests", label: "Needs you", count: counts.requester, empty: "Nothing sent back or waiting on an answer" });
  if (roles.has("approver")) tiles.push({ href: "/approvals", label: "Awaiting your approval", count: counts.approver, empty: "Nothing to approve" });
  if (roles.has("accountant")) tiles.push({ href: "/accounts", label: "To account", count: counts.accountant, empty: "Nothing to book" });
  if (roles.has("payer")) tiles.push({ href: "/payments", label: "To pay", count: counts.payer, empty: "Nothing to pay" });

  const firstName = user.name?.split(" ")[0];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-balance">
            {greeting(now)}
            {firstName && `, ${firstName}`}
          </h1>
          <p className="text-sm text-ink-2">
            {new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" }).format(now)}
          </p>
        </div>
        {roles.has("requester") && (
          <Link href="/requests/new" className={buttonClass("primary")}>
            + Raise a request
          </Link>
        )}
      </div>

      {tiles.length > 0 ? (
        <ul className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
          {tiles.map((t) => (
            <li key={t.href}>
              <Link
                href={t.href}
                className="flex h-full flex-col gap-2 rounded-xl border border-line bg-surface p-4 transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
              >
                <span className={eyebrowClass}>{t.label}</span>
                {t.count === undefined ? (
                  <span className="text-sm text-ink-3">Count unavailable, open the queue</span>
                ) : (
                  <>
                    <span className={`font-mono text-3xl leading-none font-medium tracking-tight ${t.count > 0 ? "text-ink" : "text-ink-3"}`}>{t.count}</span>
                    {t.count === 0 && <span className="text-[13px] text-ink-3">{t.empty}</span>}
                  </>
                )}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="max-w-prose text-ink-2">
          None of your roles has a queue here yet. Super admin and developer tools will appear on this page once they&apos;re built.
        </p>
      )}
    </div>
  );
}
