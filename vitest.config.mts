import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirrors tsconfig.json's "@/*" -> "./src/*" — Next's Turbopack resolves
    // this automatically, but Vitest needs it spelled out explicitly.
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    // .claude/worktrees holds full nested git worktrees (their own
    // tests/, their own node_modules) for parallel agent sessions —
    // Vitest's own defaults exclude node_modules/dist/.git/etc but not an
    // arbitrary nested worktree directory, so without this a run from the
    // repo root discovers and executes another worktree's test files
    // alongside this session's own, against whatever state that worktree
    // happens to be in. Extend the defaults, don't replace them — losing
    // the node_modules exclude would be far worse than the problem this
    // fixes. Same class of bug eslint.config.mjs's own .claude/** ignore
    // fixes for lint.
    exclude: [...configDefaults.exclude, ".claude/**"],
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
    // Raised again to 60s in phase 10: tests/payer-verification.test.ts's
    // "a second, separate open request... re-requires verification" case
    // chains two full raise->approve->account cycles plus two setVendorBank
    // calls plus several readiness checks in one test (deliberately, to
    // prove the live-read flag against a second real request rather than
    // asserting it in the abstract) — comfortably under 45s locally but
    // timed out on CI at exactly that ceiling.
    // Raised again to 120s in phase 11, after two rounds of per-test
    // overrides on individually "heavy" tests kept failing on different
    // tests each run: CI's whole suite ran ~6x slower than a local run in
    // one observed case (1684s of test time vs ~280s locally), not just the
    // heaviest three or four tests — a network-latency-to-ap-south-1
    // problem shared by every test, sized to how many round trips it makes.
    // Per-test overrides were reverted in favor of this global bump once
    // the pattern was clear.
    testTimeout: 120_000,
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
