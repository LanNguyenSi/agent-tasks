import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _checkCache,
  _clearCheckCache,
  classifyCheckRuns,
  classifyPullRequest,
  fetchCheckRunStatus,
  fetchPullRequestStatus,
  GithubChecksError,
  type PullResponse,
} from "../../src/services/github-checks.js";

const SHA = "deadbeef";

describe("classifyCheckRuns", () => {
  it("returns empty for no runs", () => {
    const r = classifyCheckRuns([], SHA);
    expect(r.state).toBe("empty");
    expect(r.total).toBe(0);
  });

  it("success when every completed run succeeded", () => {
    const r = classifyCheckRuns(
      [
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "success" },
      ],
      SHA,
    );
    expect(r.state).toBe("success");
    expect(r.successful).toBe(2);
  });

  it("success also when neutral or skipped are mixed in", () => {
    const r = classifyCheckRuns(
      [
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "neutral" },
        { status: "completed", conclusion: "skipped" },
      ],
      SHA,
    );
    expect(r.state).toBe("success");
  });

  it("failing when at least one run failed", () => {
    const r = classifyCheckRuns(
      [
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "failure" },
      ],
      SHA,
    );
    expect(r.state).toBe("failing");
    expect(r.failing).toBe(1);
  });

  it("failing on cancelled, timed_out, action_required, stale", () => {
    for (const c of ["cancelled", "timed_out", "action_required", "stale"] as const) {
      const r = classifyCheckRuns([{ status: "completed", conclusion: c }], SHA);
      expect(r.state).toBe("failing");
    }
  });

  it("pending when at least one run is still in_progress", () => {
    const r = classifyCheckRuns(
      [
        { status: "completed", conclusion: "success" },
        { status: "in_progress", conclusion: null },
      ],
      SHA,
    );
    expect(r.state).toBe("pending");
    expect(r.pending).toBe(1);
  });

  it("pending when queued", () => {
    const r = classifyCheckRuns([{ status: "queued", conclusion: null }], SHA);
    expect(r.state).toBe("pending");
  });

  it("pending wins over failing (CI still settling)", () => {
    // If anything's still running, we can't call it — even if something
    // already failed, the final result might still flip or be re-run.
    const r = classifyCheckRuns(
      [
        { status: "completed", conclusion: "failure" },
        { status: "in_progress", conclusion: null },
      ],
      SHA,
    );
    expect(r.state).toBe("pending");
  });

  it("completed-without-conclusion treated as pending (fail-safe)", () => {
    const r = classifyCheckRuns([{ status: "completed", conclusion: null }], SHA);
    expect(r.state).toBe("pending");
  });

  it("unknown conclusion → unknown state (fail closed)", () => {
    const r = classifyCheckRuns(
      [{ status: "completed", conclusion: "future_value" as never }],
      SHA,
    );
    expect(r.state).toBe("unknown");
  });
});

// ── fetchCheckRunStatus + cache ────────────────────────────────────────────

describe("fetchCheckRunStatus", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _clearCheckCache();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockPullAndChecks(sha: string, runs: Array<{ status: string; conclusion: string | null }>) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/pulls/")) {
        return new Response(
          JSON.stringify({ head: { sha }, state: "open", merged: false }),
          { status: 200 },
        );
      }
      if (url.includes("/check-runs")) {
        return new Response(JSON.stringify({ total_count: runs.length, check_runs: runs }), {
          status: 200,
        });
      }
      throw new Error("unexpected URL: " + url);
    });
  }

  it("returns success when all checks passed", async () => {
    mockPullAndChecks("abc123", [
      { status: "completed", conclusion: "success" },
    ]);
    const result = await fetchCheckRunStatus("o", "r", 1, "token");
    expect(result.state).toBe("success");
    expect(result.sha).toBe("abc123");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches both PR and check-runs lookups within TTL", async () => {
    mockPullAndChecks("sha1", [{ status: "completed", conclusion: "success" }]);
    const now = 1_000_000;
    const first = await fetchCheckRunStatus("o", "r", 1, "token", now);
    expect(first.state).toBe("success");

    // Second call within TTL: both the PR cache and the check-runs cache
    // are warm, so no additional fetches are made. This is a change from
    // the pre-PR-cache behavior where the PR was always re-fetched.
    const before = fetchMock.mock.calls.length;
    const second = await fetchCheckRunStatus("o", "r", 1, "token", now + 30_000);
    expect(second.state).toBe("success");
    expect(fetchMock.mock.calls.length - before).toBe(0);
  });

  it("cache expires after 60 seconds", async () => {
    mockPullAndChecks("sha1", [{ status: "completed", conclusion: "success" }]);
    const t0 = 5_000_000;
    await fetchCheckRunStatus("o", "r", 1, "token", t0);
    const before = fetchMock.mock.calls.length;
    // +61s → past TTL, expect both lookups to run again
    await fetchCheckRunStatus("o", "r", 1, "token", t0 + 61_000);
    expect(fetchMock.mock.calls.length - before).toBe(2);
  });

  it("force-push is picked up once the 60s PR cache expires", async () => {
    // The shared PR cache means a force-push within 60s is NOT seen
    // immediately — both ciGreen and prMerged trade a 60s staleness
    // window for one API call per task per minute. After the TTL
    // expires, the next call fetches the fresh PR and the fresh
    // check-runs for the new SHA.
    let sha = "old";
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/pulls/")) {
        return new Response(
          JSON.stringify({ head: { sha }, state: "open", merged: false }),
          { status: 200 },
        );
      }
      if (url.includes("/check-runs")) {
        return new Response(
          JSON.stringify({
            total_count: 1,
            check_runs: [{ status: "completed", conclusion: "success" }],
          }),
          { status: 200 },
        );
      }
      throw new Error("unexpected");
    });
    const now = 10_000_000;
    await fetchCheckRunStatus("o", "r", 1, "token", now);
    sha = "new"; // force push
    const before = fetchMock.mock.calls.length;
    // Within TTL: no re-fetch.
    await fetchCheckRunStatus("o", "r", 1, "token", now + 30_000);
    expect(fetchMock.mock.calls.length - before).toBe(0);
    // Past TTL: both caches expire, fresh PR + fresh check-runs.
    await fetchCheckRunStatus("o", "r", 1, "token", now + 61_000);
    expect(fetchMock.mock.calls.length - before).toBe(2);
  });

  it("throws GithubChecksError on non-2xx response", async () => {
    fetchMock.mockResolvedValue(new Response("rate limited", { status: 429 }));
    await expect(fetchCheckRunStatus("o", "r", 1, "token")).rejects.toBeInstanceOf(
      GithubChecksError,
    );
  });

  it("throws on a malformed PR response missing head.sha", async () => {
    // A latent bug: unchecked `pull.head.sha` propagated `undefined` into
    // the cache key and the check-runs URL. Guard at the network boundary.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/pulls/")) {
        return new Response(
          JSON.stringify({ head: {}, state: "open", merged: false }),
          { status: 200 },
        );
      }
      throw new Error("should not reach check-runs");
    });
    await expect(fetchCheckRunStatus("o", "r", 1, "token")).rejects.toBeInstanceOf(
      GithubChecksError,
    );
    // And no poisoned cache entry under an `undefined` key.
    expect(_checkCache.size).toBe(0);
  });

  it("shares the PR cache between check-runs and pr-status lookups", async () => {
    // A task with both ciGreen and prMerged gates should produce only one
    // /pulls/:n fetch per 60s — both reads hit the shared PR cache.
    let pullCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/pulls/")) {
        pullCalls += 1;
        return new Response(
          JSON.stringify({ head: { sha: "abc" }, state: "open", merged: false }),
          { status: 200 },
        );
      }
      if (url.includes("/check-runs")) {
        return new Response(
          JSON.stringify({ total_count: 1, check_runs: [{ status: "completed", conclusion: "success" }] }),
          { status: 200 },
        );
      }
      throw new Error("unexpected");
    });
    const now = 42_000_000;
    await fetchCheckRunStatus("o", "r", 1, "token", now);
    await fetchPullRequestStatus("o", "r", 1, "token", now);
    expect(pullCalls).toBe(1);
  });

  it("error message does not include the response body", async () => {
    // Response bodies on some GitHub endpoints can contain tokens or
    // sensitive info. Our error should name only the status + path.
    fetchMock.mockResolvedValue(
      new Response('{"message":"secret","token":"ghs_abc"}', { status: 401 }),
    );
    try {
      await fetchCheckRunStatus("o", "r", 1, "token");
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain("ghs_abc");
      expect((err as Error).message).not.toContain("secret");
    }
  });
});

// ── classifyPullRequest ────────────────────────────────────────────────────

function pr(overrides: Partial<PullResponse> = {}): PullResponse {
  return {
    head: { sha: "abc123" },
    state: "open",
    merged: false,
    ...overrides,
  };
}

describe("classifyPullRequest", () => {
  it("open PR → open", () => {
    expect(classifyPullRequest(pr({ state: "open", merged: false })).state).toBe("open");
  });

  it("closed + merged → merged", () => {
    expect(classifyPullRequest(pr({ state: "closed", merged: true })).state).toBe("merged");
  });

  it("closed + unmerged → closed_unmerged (rejected)", () => {
    expect(classifyPullRequest(pr({ state: "closed", merged: false })).state).toBe(
      "closed_unmerged",
    );
  });

  it("open + merged (impossible combo) → unknown (fail closed)", () => {
    // GitHub shouldn't emit this, but if they do we treat it conservatively
    // instead of passing the gate on contradictory data.
    expect(classifyPullRequest(pr({ state: "open", merged: true })).state).toBe("unknown");
  });

  it("returns the head sha for correlation", () => {
    expect(classifyPullRequest(pr({ head: { sha: "feedface" } })).sha).toBe("feedface");
  });
});

// ── fetchPullRequestStatus + malformed response guards ────────────────────

describe("fetchPullRequestStatus", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _clearCheckCache();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns merged for a closed-merged PR", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ head: { sha: "x" }, state: "closed", merged: true }),
        { status: 200 },
      ),
    );
    const status = await fetchPullRequestStatus("o", "r", 1, "token");
    expect(status.state).toBe("merged");
  });

  it("throws on malformed response missing merged flag", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ head: { sha: "x" }, state: "closed" }),
        { status: 200 },
      ),
    );
    await expect(fetchPullRequestStatus("o", "r", 1, "token")).rejects.toBeInstanceOf(
      GithubChecksError,
    );
  });

  it("throws on malformed response with unknown state value", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ head: { sha: "x" }, state: "draft", merged: false }),
        { status: 200 },
      ),
    );
    await expect(fetchPullRequestStatus("o", "r", 1, "token")).rejects.toBeInstanceOf(
      GithubChecksError,
    );
  });

  it("propagates GithubChecksError on API failure", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(fetchPullRequestStatus("o", "r", 1, "token")).rejects.toBeInstanceOf(
      GithubChecksError,
    );
  });
});
