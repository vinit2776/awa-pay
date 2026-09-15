// A plain, hand-written service worker — no PWA library. Serwist's own
// Next.js integration only works under Webpack; this project's build
// already runs on Turbopack by default (Next 16), and the Turbopack-
// compatible alternative (@serwist/turbopack) integrates via a dynamic
// route handler with too little precedent to trust without documentation
// this session couldn't fetch. Written by hand instead — small enough
// that the risk of getting it wrong is lower than the risk of a subtly
// broken library integration. This mirrors what the previous version of
// this project did for the same underlying reason (docs/concept-v2.html's
// own stack-carryover table).
//
// AGENTS.md rule 2, the only rule this file exists to satisfy: "The
// service worker must never cache page HTML." A shared plant or office
// device means the next person to open the app is someone else — caching
// a page would mean the next person sees where the last person was.
// Static, content-hashed assets are safe to cache (they're immutable and
// carry no user data); navigation requests are never cached, and a failed
// one falls back to the generic, static /offline page — never a copy of
// anyone's session.

const CACHE_VERSION = "v1";
const STATIC_CACHE = `awa-pay-static-${CACHE_VERSION}`;
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.add(OFFLINE_URL)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== STATIC_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function isImmutableStaticAsset(url) {
  // Next's own build output under /_next/static/ is content-hashed and
  // safe to cache forever; this project's own icons are versioned by
  // filename too (icon-192.png, icon-512.png). Nothing else qualifies —
  // in particular, /_next/image and any API/server-action route are
  // deliberately excluded, since those can carry per-user content.
  return url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  // Never cache page HTML. A navigation request always goes to the
  // network; only a genuine failure (no connection at all) falls back to
  // the precached, generic offline page.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  const url = new URL(request.url);
  if (isImmutableStaticAsset(url)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }),
    );
    return;
  }

  // Everything else — API routes, server actions, presigned R2 uploads —
  // is never intercepted, always a plain network request.
});
