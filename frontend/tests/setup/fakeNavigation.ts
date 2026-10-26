/**
 * A tiny in-memory stand-in for `next/navigation`, for tests that render the
 * header and a page together. It keeps a history stack that approximates the
 * browser's: `router.push` adds an entry (dropping the forward entries, like
 * `history.pushState`), `router.replace` swaps the current entry and keeps
 * the forward entries (like `history.replaceState`), and `nav.back()` /
 * `nav.forward()` stand in for the browser buttons. Every component reading
 * `usePathname` / `useSearchParams` re-renders on a change; both ignore a
 * `#hash`. It does not model the real router's asynchronous transitions,
 * prefetching or scrolling: a navigation here is synchronous.
 *
 * Usage (the factory import keeps the module instance shared with the test):
 *
 *   vi.mock("next/navigation", async () => {
 *     const m = await import("../setup/fakeNavigation");
 *     return { usePathname: m.usePathname, useRouter: m.useRouter, useSearchParams: m.useSearchParams };
 *   });
 *   import { nav, router } from "../setup/fakeNavigation";
 *
 * Call `nav.reset("/home")` in beforeEach; wrap `nav.back()` and friends in
 * `act(...)`.
 */
import { useMemo, useSyncExternalStore } from "react";
import { vi } from "vitest";

const state = { stack: ["/"], index: 0 };
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of Array.from(listeners)) l();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function current(): string {
  return state.stack[state.index] ?? "/";
}
/** The current URL without its `#hash` (the hooks never see the hash). */
function currentWithoutHash(): string {
  return current().split("#")[0] ?? "/";
}

export const nav = {
  /** Start a fresh history at `url` (no notification: call before render). */
  reset(url: string): void {
    state.stack = [url];
    state.index = 0;
  },
  push(url: string): void {
    state.stack = [...state.stack.slice(0, state.index + 1), url];
    state.index = state.stack.length - 1;
    notify();
  },
  replace(url: string): void {
    state.stack = state.stack.map((entry, i) => (i === state.index ? url : entry));
    notify();
  },
  back(): void {
    if (state.index > 0) {
      state.index -= 1;
      notify();
    }
  },
  forward(): void {
    if (state.index < state.stack.length - 1) {
      state.index += 1;
      notify();
    }
  },
  get url(): string {
    return current();
  },
  /** A copy of the history entries (for "no new entry" assertions). */
  get entries(): string[] {
    return [...state.stack];
  },
  /** Index of the current entry in `entries`. */
  get index(): number {
    return state.index;
  },
};

export const router = {
  push: vi.fn((url: string) => nav.push(url)),
  replace: vi.fn((url: string) => nav.replace(url)),
  back: vi.fn(() => nav.back()),
  forward: vi.fn(() => nav.forward()),
};

export function useRouter() {
  return router;
}
export function usePathname(): string {
  return useSyncExternalStore(
    subscribe,
    () => currentWithoutHash().split("?")[0] ?? "/",
    () => "/",
  );
}
export function useSearchParams(): URLSearchParams {
  const query = useSyncExternalStore(
    subscribe,
    () => currentWithoutHash().split("?")[1] ?? "",
    () => "",
  );
  return useMemo(() => new URLSearchParams(query), [query]);
}
