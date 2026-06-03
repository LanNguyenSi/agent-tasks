import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// ESLint 9 flat config for the backend (plain Node + TypeScript, no Next).
// Mirrors the project's frontend setup in spirit but uses the
// typescript-eslint preset directly. Non-type-checked recommended: it does
// not need the full TS program, so it stays fast and avoids the heavy
// type-aware rules (e.g. no-floating-promises) that would flood a codebase
// that has never been linted. Tightening to recommendedTypeChecked can be a
// follow-up.
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "prisma/migrations/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Soft start: the backend has never been linted. Demote the noisiest
    // stylistic rules to warnings so the first pass is exit-0 without a
    // sprawling refactor. Genuine errors (and any rule not listed here) still
    // fail the build, and the warnings are a visible backlog to burn down.
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
);
