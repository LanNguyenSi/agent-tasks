/**
 * A tiny in-memory stand-in for `next/navigation`, for tests that render the
 * header and a page together. It keeps a history stack that approximates the
 * browser's: `router.push` adds an entry (dropping the forward entries, like
 * `history.pushState`), `router.replace` swaps the current entry and keeps
 * the forward entries (like `history.replaceState`), and `nav.back()` /
 * `nav.forward()` stand in for the browser buttons. Every component reading
 * `usePathname` / `useSearchParams` re-renders on a change; both ignore a
 * `#hash`. It does not model prefetching or scrolling, and by default a
 * navigation is synchronous.
 *
 * `nav.deferNavigations()` switches on the one asynchronous trait of the app
 * router the pages depend on: a `router.push` / `router.replace` stays
 * pending until `nav.settle()`, and a newer navigation dispatched before then
 * discards the pending one (Next's action queue marks it discarded and runs
 * the newer one), so only the newest pending navigation is applied.
 * `FakeLink` stands in for `next/link`: a click is a `router.push(href)`.
 *
 * Usage (the factory import keeps the module instance shared with the test):
 *
 *   vi.mock("next/navigation", async () => {
 *     const m = await import("../setup/fakeNavigation");
 *     return { usePathname: m.usePathname, useRouter: m.useRouter, useSearchParams: m.useSearchParams };
 *   });
 *   import { nav, router } from "../setup/fakeNavigation";
 *
 * and, for link clicks,
 *
 *   vi.mock("next/link", async () => ({ default: (await import("../setup/fakeNavigation")).FakeLink }));
 *
 * Call `nav.reset("/home")` in beforeEach; wrap `nav.back()`, `nav.settle()`
 * and friends in `act(...)`.
 */
import { createElement, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { vi } from "vitest";

interface PendingNavigation {
  kind: "push" | "replace";
  url: string;
}
const state = {
  stack: ["/"],
  index: 0,
  deferred: false,
  pending: null as PendingNavigation | null,
};
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
    state.deferred = false;
    state.pending = null;
  },
  /** Hold every router navigation pending until `settle()`; a newer one
   * discards the pending one. Cleared by `reset`. */
  deferNavigations(): void {
    state.deferred = true;
  },
  /** Apply the pending navigation, if any (the newest one dispatched). */
  settle(): void {
    const pending = state.pending;
    state.pending = null;
    if (pending) nav[pending.kind](pending.url);
  },
  /** The URL of the pending navigation, or null. */
  get pending(): string | null {
    return state.pending?.url ?? null;
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

/** A router navigation: applied at once, or (deferred mode) held pending,
 * replacing and so discarding any navigation still pending. */
function navigate(kind: PendingNavigation["kind"], url: string): void {
  if (state.deferred) {
    state.pending = { kind, url };
    return;
  }
  nav[kind](url);
}

export const router = {
  push: vi.fn((url: string) => navigate("push", url)),
  replace: vi.fn((url: string) => navigate("replace", url)),
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

/** Stand-in for `next/link`: an anchor whose click is a client navigation
 * (`router.push(href)`), like the real Link's. */
export function FakeLink({
  href,
  children,
  onClick,
  ...rest
}: {
  href: string;
  children?: ReactNode;
  onClick?: (e: { preventDefault(): void }) => void;
  [attr: string]: unknown;
}) {
  return createElement(
    "a",
    {
      ...rest,
      href,
      onClick: (e: { preventDefault(): void }) => {
        onClick?.(e);
        e.preventDefault();
        router.push(href);
      },
    },
    children,
  );
}
