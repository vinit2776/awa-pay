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
    // the ap-south-1 dev project, not localhost), and auth flows chain
    // several per call. The default 5s is comfortable on a low-latency
    // connection but not from a GitHub Actions runner on the far side of
    // the world from the database.
    testTimeout: 30_000,
  },
});
