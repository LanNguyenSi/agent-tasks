/**
 * Hub root /projects/[id]: the Overview page is gone, the server page
 * redirect()s to /projects/[id]/board with the whole query forwarded (the
 * board reads taskId there). Pins: the base target, query preservation
 * (order, repeated parameters, empty values), no "?" for an empty query,
 * and that only the awaited params/searchParams matter (no data fetching).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const redirectMock = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

import ProjectHubRootPage from "../../src/app/projects/[id]/page";

type SearchParams = Record<string, string | string[] | undefined>;

async function redirectTo(
  searchParams: SearchParams,
  id = "p1",
): Promise<string> {
  await ProjectHubRootPage({
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve(searchParams),
  });
  expect(redirectMock).toHaveBeenCalledTimes(1);
  return redirectMock.mock.calls[0][0] as string;
}

beforeEach(() => {
  redirectMock.mockReset();
});

describe("/projects/[id] hub root", () => {
  it("redirects to the board with no query and no trailing question mark", async () => {
    expect(await redirectTo({})).toBe("/projects/p1/board");
  });

  it("forwards taskId so the board opens the task modal", async () => {
    expect(await redirectTo({ taskId: "k1" })).toBe(
      "/projects/p1/board?taskId=k1",
    );
  });

  it("keeps every parameter in its original order", async () => {
    expect(await redirectTo({ view: "list", taskId: "k1" })).toBe(
      "/projects/p1/board?view=list&taskId=k1",
    );
  });

  it("keeps repeated parameters in order", async () => {
    expect(await redirectTo({ tag: ["a", "b"] })).toBe(
      "/projects/p1/board?tag=a&tag=b",
    );
  });

  it("keeps an empty-valued parameter", async () => {
    expect(await redirectTo({ q: "" })).toBe("/projects/p1/board?q=");
  });

  it("drops an undefined parameter but keeps the rest", async () => {
    expect(await redirectTo({ a: undefined, b: "1" })).toBe(
      "/projects/p1/board?b=1",
    );
  });

  it("redirects for any project id", async () => {
    expect(
      await redirectTo(
        {},
        "3f2b8c1e-9d4a-4e6b-8a1f-0c5d7e9b2a41",
      ),
    ).toBe("/projects/3f2b8c1e-9d4a-4e6b-8a1f-0c5d7e9b2a41/board");
  });
});
