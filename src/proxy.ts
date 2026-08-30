import { NextResponse, type NextRequest } from "next/server";
import { verifyAndExtractToken } from "@/auth/cookieSignature";
import { SESSION_COOKIE } from "@/auth/cookieNames";

// Next 16 renamed middleware.ts -> proxy.ts (export name `proxy`, not
// `middleware`). This is optimistic-only, per Next's own guidance: Proxy
// runs on every request including prefetches, so it must never touch the
// database. It only rejects an absent or tampered cookie signature — the
// real, DB-backed check is src/auth/dal.ts's verifySession(), called
// independently by every Server Action and every page under (app), not
// just the layout.
const PUBLIC_PATHS = ["/login", "/login/mfa", "/login/mfa-setup"];

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return NextResponse.next();
  }

  const cookieValue = request.cookies.get(SESSION_COOKIE)?.value;
  const rawToken = cookieValue ? verifyAndExtractToken(cookieValue) : null;

  if (!rawToken) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
