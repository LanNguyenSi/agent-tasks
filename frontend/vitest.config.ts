import { defineConfig } from "vitest/config";

/**
 * Frontend test runner. Intentionally scoped to pure helpers under
 * `src/lib/` with `environment: node` — no jsdom, no React Testing
 * Library. Component tests are a separate follow-up (task 1c17f29b).
 *
 * The `.next/` build output is excluded so `next build` artifacts
 * can't be discovered as tests.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["node_modules", ".next", "dist"],
    environment: "node",
  },
});
