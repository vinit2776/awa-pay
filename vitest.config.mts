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
  },
});
