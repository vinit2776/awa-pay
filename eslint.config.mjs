import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // .claude/worktrees holds full nested git worktrees (their own
    // node_modules, .next build output, everything) for parallel agent
    // sessions — the plain ".next/**" glob above doesn't match nested
    // paths, so without this a lint run from the repo root sweeps up
    // another worktree's build artifacts as if they were this session's
    // own code.
    ".claude/**",
  ]),
  {
    // All env access under src/ funnels through src/db/runtime.ts (the
    // restricted runtime role) — never the migrations connection, and never
    // process.env read directly elsewhere. See AGENTS.md rule 1.
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/db/schema/**",
      "src/db/runtime.ts",
      "src/auth/env.ts",
      "src/storage/env.ts",
      "src/notifications/env.ts",
      "src/vendors/env.ts",
      "src/extraction/env.ts",
      // Not a secret needing the restricted-connection treatment the rule
      // above exists for — the standard dev/prod toggle, checked once to
      // decide whether the service worker registers at all (see the
      // file's own comment on why registration is production-only).
      "src/app/ServiceWorkerRegistration.tsx",
    ],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message: "Do not read process.env directly in src/. Import from src/db/runtime.ts.",
        },
      ],
    },
  },
]);

export default eslintConfig;
