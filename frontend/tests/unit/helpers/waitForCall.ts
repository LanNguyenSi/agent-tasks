/**
 * Test helper: read a mock's call list only once the call can have happened.
 *
 * A mock driven by a promise (a mocked API function called from a mount
 * effect, a router call from an event handler that resolves first) records
 * the call when the promise settles, not when the test awaited some other
 * DOM or await point. Reading `someMock.mock.calls` right after render or
 * after a `waitFor` on something else is a race that only shows under load:
 * the request may not have started yet. Use this helper instead of a bare
 * read: `vi.waitFor` retries until the mock has at least `times` calls and
 * the helper returns the (then current) `mock.mock.calls`, so the caller can
 * assert on the arguments. It waits through `vi.waitFor` rather than the
 * Testing Library one so the helper also works in the `environment: node`
 * suites. The ESLint rule scoped to `tests/**` (eslint.config.mjs) flags a
 * `.mock.calls` read outside a waitFor callback; this file is the one
 * sanctioned exception.
 * The default timeout (1000 ms) stays well under the test timeout, so a
 * mock that is never called fails with this helper's message rather than
 * a bare "Test timed out".
 * Not a test file (no `.test.` in the name): vitest does not collect it.
 */
import { vi } from "vitest";

export async function waitForCall<C extends unknown[]>(
  mock: { mock: { calls: C[] } },
  { times = 1, timeout = 1000 }: { times?: number; timeout?: number } = {},
): Promise<C[]> {
  return vi.waitFor(
    () => {
      const calls = mock.mock.calls;
      if (calls.length < times) {
        throw new Error(
          `waitForCall: expected the mock to have been called at least ${times} time(s), saw ${calls.length}`,
        );
      }
      return calls;
    },
    { timeout, interval: 10 },
  );
}
