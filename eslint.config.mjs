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
  ]),
  {
    // All env access under src/ funnels through src/db/runtime.ts (the
    // restricted runtime role) — never the migrations connection, and never
    // process.env read directly elsewhere. See AGENTS.md rule 1.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/db/schema/**", "src/db/runtime.ts", "src/auth/env.ts", "src/storage/env.ts"],
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
