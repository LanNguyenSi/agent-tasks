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
 *
 * Rule for component tests: do not assert effect-driven state right after
 * awaiting other DOM. A state update that arrives through a promise (a mocked
 * API answer) commits outside `act`, and the passive effects of that commit
 * (document.title, a mock called from a mount effect, a localStorage write, a
 * router call) are scheduled afterwards, so under load they can run after the
 * DOM update a `findBy*` or `waitFor` saw. Wait for the asserted condition
 * itself:
 *   - tab title: `await expectDocumentTitle(...)` (tests/unit/helpers/documentTitle.ts);
 *     eslint.config.mjs flags a bare `expect(document.title)` in tests;
 *   - a mock call or count: `await waitForCall(mock)` (or the call itself
 *     inside a `waitFor` callback, e.g. `await waitFor(() => expect(mock)
 *     .toHaveBeenCalledTimes(n))`), and when the count must stay exact,
 *     settle pending effects afterwards
 *     (`await act(async () => { await Promise.resolve(); })`) and assert it
 *     again (see SettingsTeamPage.headerSync.test.tsx). Reading
 *     `mock.calls` outside a `waitFor` callback is now mechanically guarded:
 *     eslint.config.mjs flags it in tests (waitForCall is the sanctioned
 *     reader). Whether a waited-for call is the *right* call (an exact count
 *     that a late extra call would break) stays a review rule.
 * Safe without a wait: the awaited element is itself rendered from the
 * effect's result (the effect ran first), the asserted call is made by an
 * event handler or an async function rather than an effect, or the update was
 * triggered inside `act` (RTL's fireEvent, userEvent).
 */
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
