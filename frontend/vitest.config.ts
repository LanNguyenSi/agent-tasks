import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Frontend test runner.
 *
 * Default environment is `node` so pure-helper tests under `src/lib/`
 * and `tests/unit/*.test.ts` stay fast. Component tests opt into
 * `jsdom` per-file via `/** @vitest-environment jsdom *\/` docblock,
 * keeping the jsdom cost isolated to files that actually render React.
 *
 * `@vitejs/plugin-react` is required so the Rolldown/esbuild transform
 * understands JSX in `.tsx` test files — without it, any
 * `render(<Component ... />)` in a test triggers "Unexpected JSX
 * expression" at parse time. The plugin is cheap and has no effect on
 * the pure-helper `.test.ts` suites.
 *
 * The `setupFiles` entry loads the `@testing-library/jest-dom` matchers
 * — Vitest only runs setup files for suites that match, so the node
 * suites stay unaffected as long as the setup itself is side-effect-free
 * at the module level (it is — jest-dom only extends `expect`).
 *
 * The `.next/` build output is excluded so `next build` artifacts can't
 * be discovered as tests.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "src/**/*.test.ts"],
    exclude: ["node_modules", ".next", "dist"],
    environment: "node",
    setupFiles: ["./tests/setup/vitest.setup.ts"],
  },
});
