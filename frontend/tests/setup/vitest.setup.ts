/**
 * Loaded by Vitest before every test file. Two jobs:
 *
 * 1. Extend `expect` with the matchers from `@testing-library/jest-dom`
 *    (toBeInTheDocument, toBeDisabled, toHaveValue, etc.) so component
 *    tests can assert on the rendered DOM in a familiar way.
 * 2. Register an `afterEach` hook that calls `cleanup()` from React
 *    Testing Library. RTL's auto-cleanup only fires automatically when
 *    it detects Jest's global environment — under Vitest, prior renders
 *    would leak into subsequent tests without this explicit hook,
 *    causing `getBy*` queries to find stale DOM from earlier cases.
 *
 * Both are safe to load in `environment: node` suites: jest-dom only
 * mutates Vitest's expect registry, and `cleanup` is a no-op when
 * nothing was rendered.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
