/**
 * Unit tests for the waitForCall helper (tests/unit/helpers/waitForCall.ts):
 * the helper is the sanctioned way to read a mock's call list, so its three
 * behaviours (already called, delayed call, never called) each get a case.
 */
import { describe, it, expect, vi } from "vitest";
import { waitForCall } from "./waitForCall";

describe("waitForCall", () => {
  it("resolves immediately when the mock has already been called, returning the calls", async () => {
    const m = vi.fn();
    m("a", 1);
    const calls = await waitForCall(m);
    expect(calls).toEqual([["a", 1]]);
  });

  it("waits for a call that happens after a delay", async () => {
    const m = vi.fn();
    setTimeout(() => m("late"), 30);
    const calls = await waitForCall(m);
    expect(calls).toEqual([["late"]]);
  });

  it("waits until the explicit times count is reached (overrides the default of 1)", async () => {
    const m = vi.fn();
    m("one");
    setTimeout(() => m("two"), 30);
    const calls = await waitForCall(m, { times: 2 });
    expect(calls.map((c) => c[0])).toEqual(["one", "two"]);
  });

  it("times out with a clear message when the mock is never called", async () => {
    await expect(waitForCall(vi.fn(), { timeout: 100 })).rejects.toThrow(
      "expected the mock to have been called at least 1 time(s), saw 0",
    );
  });
});
