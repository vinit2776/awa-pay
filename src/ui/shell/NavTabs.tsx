"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeHref, type NavIcon, type NavItem } from "./nav";

const ICON_PATH: Record<NavIcon, string> = {
  home: "M4 11l8-6 8 6v8H4z",
  raise: "M12 5v14M5 12h14",
  mine: "M6 4h12v16H6zM9 9h6M9 13h6",
  approve: "M5 12l4 4 10-10",
  account: "M5 4h14v16H5zM8 8h8M8 12h8M8 16h4",
  pay: "M3 7h18v10H3zM3 11h18",
  admin: "M12 12a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM5 20c1-4 3.8-5.5 7-5.5s6 1.5 7 5.5",
};

function Icon({ name, className }: { name: NavIcon; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === "raise" ? 2.2 : 1.7} className={className} aria-hidden>
      <path d={ICON_PATH[name]} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Count({ n, active }: { n?: number; active: boolean }) {
  if (!n) return null;
  return (
    <span className={`rounded px-1.5 font-mono text-[11px] ${active ? "bg-accent text-accent-ink" : "bg-sunk text-ink-2"}`}>{n}</span>
  );
}

// Desktop: tabs in the top bar. Hidden below md, where the bottom bar takes over.
export function DesktopTabs({ items }: { items: NavItem[] }) {
  const current = activeHref(usePathname(), items.map((i) => i.href));
  return (
    <nav aria-label="Main" className="hidden flex-wrap gap-0.5 md:flex">
      {items.map((item) => {
        const active = item.href === current;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] ${
              active ? "bg-accent-soft font-semibold text-accent" : "text-ink-2 hover:bg-sunk hover:text-ink"
            }`}
          >
            {item.label}
            <Count n={item.count} active={active} />
          </Link>
        );
      })}
    </nav>
  );
}

// Phone: a fixed bottom bar, with Raise drawn as the one filled button.
export function MobileTabBar({ items }: { items: NavItem[] }) {
  const current = activeHref(usePathname(), items.map((i) => i.href));
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-20 grid border-t border-line-soft bg-surface px-1 pt-1.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:hidden"
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
    >
      {items.map((item) => {
        const active = item.href === current;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`relative flex flex-col items-center gap-0.5 text-[10.5px] ${active || item.primary ? "font-semibold text-accent" : "text-ink-3"}`}
          >
            {item.primary ? (
              <span className="grid h-7 w-10 place-items-center rounded-full bg-accent text-accent-ink">
                <Icon name={item.icon} className="size-[18px]" />
              </span>
            ) : (
              <Icon name={item.icon} className="size-5" />
            )}
            {item.short}
            {!!item.count && (
              <span className="absolute top-0 left-1/2 ml-2 min-w-4 rounded-full bg-warn px-1 text-center font-mono text-[10px] leading-4 text-surface">
                {item.count}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
