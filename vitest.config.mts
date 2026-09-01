import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirrors tsconfig.json's "@/*" -> "./src/*" — Next's Turbopack resolves
    // this automatically, but Vitest needs it spelled out explicitly.
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    setupFiles: ["./tests/setup.ts"],
    // Isolation depends on real Postgres/RLS behavior — no mocked DB, and
    // tests that share fixtures run sequentially rather than racing writes
    // against the one shared dev project.
    fileParallelism: false,
    // Every withXScope call is its own transaction (a real round trip to
    // the ap-south-1 dev project, not localhost), and auth/transition
    // flows chain several per call. The default 5s is comfortable on a
    // low-latency connection but not from a GitHub Actions runner on the
    // far side of the world from the database. Raised from 30s to 45s in
    // phase 6: runTransition's freeze check adds one more query to every
    // single transition call, and CI (unlike a local run) was already
    // landing within ~1s of the old ceiling on some desks.test.ts cases
    // before that extra round trip existed — a live timeout, not a
    // hypothetical one (payment.reference's uniqueness test, which runs
    // six transitions back to back, timed out on CI at exactly 30s).
    testTimeout: 45_000,
  },
});
