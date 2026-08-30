import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
    // Isolation depends on real Postgres/RLS behavior — no mocked DB, and
    // tests that share fixtures run sequentially rather than racing writes
    // against the one shared dev project.
    fileParallelism: false,
  },
});
