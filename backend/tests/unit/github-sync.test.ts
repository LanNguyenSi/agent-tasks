/**
 * Unit tests for the listUserRepos service.
 *
 * The function is a pure raw-fetch paginator — no Prisma, no DB, no Octokit.
 * vi.stubGlobal replaces the global fetch so every branch can be exercised
 * without a real network connection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { listUserRepos } from "../../src/services/github-sync.js";
import type { GitHubRepo } from "../../src/services/github-sync.js";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------- helpers ---------------------------------------------------------

function makeRepo(id: number, archived = false, disabled = false): GitHubRepo {
  return {
    id,
    name: `repo-${id}`,
    full_name: `owner/repo-${id}`,
    description: null,
    archived,
    disabled,
  };
}

function makePage(count: number, archived = false, disabled = false): GitHubRepo[] {
  return Array.from({ length: count }, (_, i) => makeRepo(i + 1, archived, disabled));
}

function okResponse(repos: GitHubRepo[]) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(repos),
  };
}

function errResponse(status: number) {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
  };
}

// ---------- tests -----------------------------------------------------------

describe("listUserRepos", () => {
  it("single page: returns all active repos and stops after page 1 when fewer than 100 returned", async () => {
    const repos = makePage(5);
    fetchMock.mockResolvedValueOnce(okResponse(repos));

    const result = await listUserRepos("tok_test");

    expect(result).toHaveLength(5);
    expect(result[0].name).toBe("repo-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, unknown];
    expect(url).toContain("page=1");
    expect(url).toContain("per_page=100");
  });

  it("multi-page: fetches page 2 when page 1 returns exactly 100 and breaks early on a short page 2", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse(makePage(100)))
      .mockResolvedValueOnce(okResponse(makePage(50)));

    const result = await listUserRepos("tok_test");

    expect(result).toHaveLength(150);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url1] = fetchMock.mock.calls[0] as [string, unknown];
    const [url2] = fetchMock.mock.calls[1] as [string, unknown];
    expect(url1).toContain("page=1");
    expect(url2).toContain("page=2");
  });

  it("5-page cap: stops after page 5 even when every page returns exactly 100 repos", async () => {
    for (let i = 0; i < 5; i++) {
      fetchMock.mockResolvedValueOnce(okResponse(makePage(100)));
    }

    const result = await listUserRepos("tok_test");

    expect(result).toHaveLength(500);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const lastUrl = (fetchMock.mock.calls[4] as [string, unknown])[0];
    expect(lastUrl).toContain("page=5");
  });

  it("error branch: rejects with the HTTP status code embedded in the error message", async () => {
    fetchMock.mockResolvedValueOnce(errResponse(401));

    await expect(listUserRepos("tok_bad")).rejects.toThrow(
      "Failed to fetch GitHub repositories (401)",
    );
  });

  it("Authorization header: sends the access token as a Bearer token", async () => {
    fetchMock.mockResolvedValueOnce(okResponse(makePage(1)));

    await listUserRepos("my_secret_token");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer my_secret_token",
    );
  });

  it("filter: excludes any repo where archived is true, disabled is true, or both; keeps repos where both are false", async () => {
    const page = [
      makeRepo(1, false, false), // active               → included
      makeRepo(2, true, true),   // archived AND disabled → excluded
      makeRepo(3, true, false),  // archived only         → excluded
      makeRepo(4, false, true),  // disabled only         → excluded
    ];
    fetchMock.mockResolvedValueOnce(okResponse(page));

    const result = await listUserRepos("tok_test");

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });
});
