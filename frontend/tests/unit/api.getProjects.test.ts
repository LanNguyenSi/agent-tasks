/**
 * getProjects(teamId?): with a team id the request names it; without one (a
 * user who belongs to no team, listing the projects shared with them) it
 * sends no `teamId` parameter at all, never `teamId=undefined` or an empty one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getProjects } from "../../src/lib/api";
import { waitForCall } from "./helpers/waitForCall";

const realFetch = globalThis.fetch;

function mockFetch() {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ projects: [{ id: "p-1" }] }),
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

async function requestedUrl(fn: ReturnType<typeof vi.fn>): Promise<string> {
  const calls = await waitForCall(fn);
  return String(calls[0]![0]);
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("getProjects", () => {
  it("names the team when one is given", async () => {
    const fn = mockFetch();
    await expect(getProjects("t-1")).resolves.toEqual([{ id: "p-1" }]);
    expect(await requestedUrl(fn)).toMatch(/\/api\/projects\?teamId=t-1$/);
  });

  it("sends no team parameter when called without one", async () => {
    const fn = mockFetch();
    await getProjects();
    expect(await requestedUrl(fn)).toMatch(/\/api\/projects$/);
  });

  it("treats an empty team id like an absent one", async () => {
    const fn = mockFetch();
    await getProjects("");
    expect(await requestedUrl(fn)).toMatch(/\/api\/projects$/);
  });
});
