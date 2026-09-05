"use client";

import { useEffect } from "react";

// Mounted in the root layout — not the (app) group's — so registration
// happens regardless of auth state, matching how a PWA install prompt
// isn't gated on being logged in either. The actual service worker
// (public/sw.js) is a plain static file, not built by any bundler.
//
// Production only, found the hard way: dev mode's /_next/static/ chunk
// URLs aren't guaranteed content-hash-stable the way a real production
// build's are (Turbopack's dev server reuses URLs across rebuilds in a
// way its own HMR client accounts for) — cache-first-forever against
// those in dev means the browser keeps serving JS from before a code
// change long after the dev server itself has moved on, which looks
// exactly like "the fix isn't applying" and cost real time to track down.
// Matches Serwist's own default of disabling registration in development
// for this same reason.
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.error("[pwa] service worker registration failed:", err);
    });
  }, []);

  return null;
}
