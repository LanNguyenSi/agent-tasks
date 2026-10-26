/** @vitest-environment jsdom */
/**
 * Legacy /dashboard redirect (app/dashboard/page.tsx) to the project board
 * at /projects/<id>/board.
 *
 * Pinned: a `projectId` query wins and every parameter except `teamId` and
 * `projectId` is forwarded in its original order; without one, the last
 * board stored by the board page (`dashboard:lastProject:<teamId>`) is
 * resumed, for the given team only when a `teamId` is present, else for the
 * Projects page's last team, else for any team; with nothing stored the
 * Projects page is the target. One `router.replace`, no `push`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

import DashboardRedirectPage from "../../src/app/dashboard/page";

async function redirectFrom(url: string): Promise<string> {
  window.history.replaceState({}, "", url);
  render(<DashboardRedirectPage />);
  await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledTimes(1));
  expect(routerMocks.push).not.toHaveBeenCalled();
  return routerMocks.replace.mock.calls[0]![0] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/dashboard with a projectId", () => {
  it("goes to that project's board", async () => {
    expect(await redirectFrom("/dashboard?projectId=p1")).toBe("/projects/p1/board");
  });

  it("forwards taskId so the board opens the task modal", async () => {
    expect(await redirectFrom("/dashboard?projectId=p1&taskId=k1")).toBe(
      "/projects/p1/board?taskId=k1",
    );
  });

  it("drops teamId and keeps every other parameter in order", async () => {
    expect(await redirectFrom("/dashboard?teamId=t1&projectId=p1&taskId=k1&view=list")).toBe(
      "/projects/p1/board?taskId=k1&view=list",
    );
  });

  it("prefers the query over a stored last board", async () => {
    window.localStorage.setItem("dashboard:lastProject:t1", "p-stored");
    expect(await redirectFrom("/dashboard?teamId=t1&projectId=p1")).toBe("/projects/p1/board");
  });
});

describe("/dashboard with a teamId only", () => {
  it("resumes that team's last board", async () => {
    window.localStorage.setItem("dashboard:lastProject:t1", "p-t1");
    window.localStorage.setItem("dashboard:lastProject:t2", "p-t2");
    expect(await redirectFrom("/dashboard?teamId=t1")).toBe("/projects/p-t1/board");
  });

  it("goes to that team's Projects page when it has no stored board, not to another team's", async () => {
    window.localStorage.setItem("dashboard:lastProject:t2", "p-t2");
    expect(await redirectFrom("/dashboard?teamId=t1")).toBe("/teams?teamId=t1");
  });
});

describe("bare /dashboard", () => {
  it("resumes the board of the Projects page's last team first", async () => {
    window.localStorage.setItem("dashboard:lastProject:t1", "p-t1");
    window.localStorage.setItem("dashboard:lastProject:t2", "p-t2");
    window.localStorage.setItem("agent-tasks:lastTeamId", "t2");
    expect(await redirectFrom("/dashboard")).toBe("/projects/p-t2/board");
  });

  it("resumes any stored board when the last team has none", async () => {
    window.localStorage.setItem("agent-tasks:lastTeamId", "t9");
    window.localStorage.setItem("dashboard:lastProject:t1", "p-t1");
    expect(await redirectFrom("/dashboard")).toBe("/projects/p-t1/board");
  });

  it("treats an empty projectId as absent", async () => {
    window.localStorage.setItem("dashboard:lastProject:t1", "p-t1");
    expect(await redirectFrom("/dashboard?projectId=&taskId=k1")).toBe(
      "/projects/p-t1/board?taskId=k1",
    );
  });

  it("goes to the Projects page when no board is stored", async () => {
    expect(await redirectFrom("/dashboard")).toBe("/teams");
  });

  it("goes to the Projects page when storage is blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(await redirectFrom("/dashboard")).toBe("/teams");
  });
});

describe("/dashboard while redirecting", () => {
  it("shows a loading status and no error", () => {
    window.history.replaceState({}, "", "/dashboard?projectId=p1");
    render(<DashboardRedirectPage />);
    expect(screen.getByRole("status")).toHaveTextContent("Opening the board");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("projectId validation", () => {
  it.each([
    ["an encoded traversal", "..%2F..%2Fsettings%23"],
    ["a slash", "a%2Fb"],
    ["a backslash", "a%5Cb"],
    ["a dot-dot", ".."],
    ["a dot segment", "a.b"],
    ["a space", "a%20b"],
    ["an empty value", ""],
  ])("rejects %s from the query and falls back to the stored board", async (_label, value) => {
    window.localStorage.setItem("dashboard:lastProject:t1", "p-t1");
    expect(await redirectFrom(`/dashboard?projectId=${value}`)).toBe("/projects/p-t1/board");
  });

  it("goes to the Projects page when the query value is invalid and nothing is stored", async () => {
    expect(await redirectFrom("/dashboard?projectId=..%2F..%2Fsettings%23")).toBe("/teams");
  });

  it.each([
    ["a UUID", "3f2b8c1e-9d4a-4e6b-8a1f-0c5d7e9b2a41"],
    ["a short id", "p1"],
    ["an id with an underscore", "p_1"],
  ])("accepts %s", async (_label, value) => {
    expect(await redirectFrom(`/dashboard?projectId=${value}`)).toBe(`/projects/${value}/board`);
  });

  it.each([
    ["the team's slot", "/dashboard?teamId=t1"],
    ["the last team's slot", "/dashboard"],
  ])("rejects an invalid stored id in %s", async (_label, url) => {
    window.localStorage.setItem("agent-tasks:lastTeamId", "t1");
    window.localStorage.setItem("dashboard:lastProject:t1", "../../settings#");
    expect(await redirectFrom(url)).toBe(url.includes("teamId") ? "/teams?teamId=t1" : "/teams");
  });

  it("skips an invalid stored id and uses a valid one from another team", async () => {
    window.localStorage.setItem("dashboard:lastProject:t1", "a/b");
    window.localStorage.setItem("dashboard:lastProject:t2", "p-t2");
    expect(await redirectFrom("/dashboard")).toBe("/projects/p-t2/board");
  });
});
