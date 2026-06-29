import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      thresholds: {
        // Per-file floor for the github-sync unit: measured 100% / floor 5 pts below.
        // NOTE: vitest silently ignores a threshold key that matches no file (the gate
        // becomes a no-op with no CI error). If this source file is renamed or moved,
        // update the key below in lockstep or coverage enforcement is silently lost.
        "src/services/github-sync.ts": {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
      },
    },
  },
});
