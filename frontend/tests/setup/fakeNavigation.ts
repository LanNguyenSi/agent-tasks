/**
 * A tiny in-memory stand-in for `next/navigation`, for tests that render the
 * header and a page together. It keeps a history stack, so `router.push`
 * (what the header switcher calls) and `nav.back()` / `nav.forward()` (the
 * browser buttons) change the URL the way the real router does, and every
 * component reading `usePathname` / `useSearchParams` re-renders with it.
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
    state.stack = [...state.stack.slice(0, state.index), url];
    state.index = state.stack.length - 1;
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
    () => current().split("?")[0] ?? "/",
    () => "/",
  );
}
export function useSearchParams(): URLSearchParams {
  const query = useSyncExternalStore(
    subscribe,
    () => current().split("?")[1] ?? "",
    () => "",
  );
  return useMemo(() => new URLSearchParams(query), [query]);
}
