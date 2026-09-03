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
    // Vitest tracks hook time (beforeAll/afterAll/beforeEach/afterEach)
    // separately from test time — testTimeout above does not cover it.
    // Default is also 10s, and tests/notifications.test.ts's beforeAll
    // (2 departments, 2 companies, 1 head_of_account, 7 users, 9 grants —
    // ~21 sequential round trips, the heaviest fixture setup of any test
    // file here) timed out on CI at exactly that default. Every other
    // test file's beforeAll does fewer round trips but the same shape, so
    // this is raised globally rather than per-file, matching the same
    // "CI's connection to ap-south-1 is not the same as local" reasoning
    // testTimeout above is already raised for.
    hookTimeout: 45_000,
  },
});
