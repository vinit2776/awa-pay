// Pure nav rules, shared by the server shell (which builds the items from
// role grants) and the client tabs (which highlight the current one).

export type NavIcon = "home" | "raise" | "mine" | "approve" | "account" | "pay" | "admin";

export type NavItem = {
  href: string;
  label: string;
  short: string;
  icon: NavIcon;
  count?: number;
  primary?: boolean;
};

export type NavRole = "requester" | "approver" | "accountant" | "payer";
export type NavCounts = Partial<Record<NavRole, number>>;

// Order is the order a bill travels, so the tabs read left to right the
// same way a request moves through the desks.
export function buildNavItems(roles: ReadonlySet<string>, counts: NavCounts): NavItem[] {
  const items: NavItem[] = [{ href: "/", label: "Home", short: "Home", icon: "home" }];
  if (roles.has("requester")) {
    items.push({ href: "/requests/new", label: "Raise a request", short: "Raise", icon: "raise", primary: true });
    items.push({ href: "/requests", label: "My requests", short: "Mine", icon: "mine", count: counts.requester });
  }
  if (roles.has("approver")) items.push({ href: "/approvals", label: "Approvals", short: "Approve", icon: "approve", count: counts.approver });
  if (roles.has("accountant")) items.push({ href: "/accounts", label: "To account", short: "Account", icon: "account", count: counts.accountant });
  if (roles.has("payer")) items.push({ href: "/payments", label: "To pay", short: "Pay", icon: "pay", count: counts.payer });
  // Last, and never counted: the super admin configures access, and never
  // approves or pays (AGENTS.md "Roles and scope").
  if (roles.has("super_admin")) items.push({ href: "/admin", label: "People & access", short: "Access", icon: "admin" });
  return items;
}

// The item whose href is the longest prefix of the path. "/" only matches
// itself, and "/requests/new" wins over "/requests" on the raise screen.
export function activeHref(pathname: string, hrefs: string[]): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    const matches = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
    if (matches && (best === null || href.length > best.length)) best = href;
  }
  return best;
}
