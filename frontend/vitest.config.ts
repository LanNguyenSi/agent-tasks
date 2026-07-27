import { fileURLToPath } from "node:url";
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

// Node 22.4+ ships an experimental global `localStorage` (unflagged by
// default on newer Node releases, e.g. Node 26) that vitest's jsdom
// environment does not override: its populateGlobal helper only copies a
// jsdom-owned key onto the worker's global when that key is either absent
// from the host global or in its hardcoded allowlist of DOM class names,
// and `localStorage` is in neither. Node's own accessor (non-functional
// unless --localstorage-file is set) therefore shadows jsdom's real
// Storage implementation, and any `window.localStorage` access in a jsdom
// test throws "Cannot read properties of undefined (reading 'clear')"
// (see tests/unit/dashboardPrefs.test.ts, src/lib/teamsPrefs.dom.test.ts).
// Disabling the flag on the worker processes vitest spawns restores the
// jsdom-backed localStorage this suite has always relied on. Guarded by
// allowedNodeEnvironmentFlags so this is a no-op on Node versions without
// the flag (e.g. CI's Node 22 baseline, or Node 20).
const execArgv = process.allowedNodeEnvironmentFlags.has(
  "--no-experimental-webstorage",
)
  ? ["--no-experimental-webstorage"]
  : [];

export default defineConfig({
  plugins: [react()],
  // Mirror the tsconfig `@/* -> ./src/*` path alias so component tests can
  // render components that use `@/`-prefixed imports (e.g. TaskDetailModal).
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    execArgv,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "src/**/*.test.ts"],
    exclude: ["node_modules", ".next", "dist"],
    environment: "node",
    setupFiles: ["./tests/setup/vitest.setup.ts"],
    coverage: {
      provider: "v8",
      thresholds: {
        // Per-file floor for the import-mapping unit: measured 100% / floor 5 pts below.
        // NOTE: vitest silently ignores a threshold key that matches no file (the gate
        // becomes a no-op with no CI error). If this source file is renamed or moved,
        // update the key below in lockstep or coverage enforcement is silently lost.
        "src/lib/import-mapping.ts": {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
      },
    },
  },
});
