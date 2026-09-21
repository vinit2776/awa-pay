import Link from "next/link";
import type { ReactNode } from "react";
import { logout } from "@/app/(app)/actions";
import { getShellContext } from "./context";
import { buildNavItems } from "./nav";
import { DesktopTabs, MobileTabBar } from "./NavTabs";

function initials(name: string | null | undefined, email: string): string {
  const source = name?.trim() || email;
  const parts = source.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export async function AppShell({ children }: { children: ReactNode }) {
  const ctx = await getShellContext();
  const items = ctx ? buildNavItems(ctx.roles, ctx.counts) : [];

  return (
    <>
      <header className="sticky top-0 z-20 border-b border-line-soft bg-surface">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-2.5">
          <Link href="/" className="flex items-center gap-2 text-[15px] font-bold tracking-tight">
            <span className="grid size-[22px] place-items-center rounded-[5px] bg-accent text-xs text-accent-ink">a</span>
            awa-pay
          </Link>
          <DesktopTabs items={items} />
          {ctx && (
            <details className="relative ml-auto">
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-1.5 py-1 text-[13px] text-ink-2 hover:bg-sunk [&::-webkit-details-marker]:hidden">
                <span className="hidden sm:inline">{ctx.user.name ?? ctx.user.email}</span>
                <span className="grid size-7 place-items-center rounded-full border border-line bg-sunk text-[11px] font-semibold">
                  {initials(ctx.user.name, ctx.user.email)}
                </span>
              </summary>
              <div className="absolute right-0 mt-1 flex w-60 flex-col gap-2 rounded-lg border border-line bg-surface p-3 shadow-lg">
                <p className="text-sm font-semibold">{ctx.user.name ?? "Signed in"}</p>
                <p className="-mt-1.5 truncate text-xs text-ink-3">{ctx.user.email}</p>
                <p className="text-xs text-ink-3">On a shared device? Sign out when you&apos;re done.</p>
                <form action={logout}>
                  <button type="submit" className="w-full rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:bg-sunk">
                    Sign out
                  </button>
                </form>
              </div>
            </details>
          )}
        </div>
      </header>
      <main className="flex flex-1 flex-col pb-20 md:pb-0">{children}</main>
      <MobileTabBar items={items} />
    </>
  );
}
