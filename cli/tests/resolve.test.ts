import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTaskId } from "../src/resolve.js";
import type { Config } from "../src/config.js";

const config: Config = { endpoint: "http://api.test", token: "tok" };

type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const FULL_UUID = "11111111-1111-1111-1111-111111111111";

describe("resolveTaskId", () => {
  it("passes a full UUID through without any network call", async () => {
    const result = await resolveTaskId(config, FULL_UUID);
    expect(result).toBe(FULL_UUID);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves a prefix matched by exactly one task in the search pool", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        tasks: [
          { id: "abcdef12-0000-0000-0000-000000000000", title: "Only match", status: "open", priority: "LOW" },
        ],
        nextCursor: null,
      }),
    );
    const result = await resolveTaskId(config, "abcdef12");
    expect(result).toBe("abcdef12-0000-0000-0000-000000000000");
  });

  it("resolves a prefix matched only on a later page (paging past the first page)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        tasks: [{ id: "11111111-0000-0000-0000-000000000000", title: "page 1", status: "open", priority: "LOW" }],
        nextCursor: "11111111-0000-0000-0000-000000000000",
      }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        tasks: [{ id: "abcdef12-0000-0000-0000-000000000000", title: "page 2 match", status: "open", priority: "LOW" }],
        nextCursor: null,
      }),
    );
    const result = await resolveTaskId(config, "abcdef12");
    expect(result).toBe("abcdef12-0000-0000-0000-000000000000");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("exits 1 with a clear message when no task matches the prefix (pool exhausted, not capped)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ tasks: [], nextCursor: null }));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(resolveTaskId(config, "ffffffff")).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("no task found"));
    // Pool was genuinely exhausted (nextCursor null), not capped -- no
    // "searched"/"capped" disclosure needed since nothing was left unscanned.
    expect(errSpy.mock.calls[0]![0] as string).not.toContain("capped");

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("discloses the search window when the hard page cap was hit with no match (never overclaims nonexistence)", async () => {
    for (let i = 0; i < 10; i++) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          tasks: [{ id: `${i}0000000-0000-0000-0000-000000000000`, title: "x", status: "open", priority: "LOW" }],
          nextCursor: `${i}0000000-0000-0000-0000-000000000000`,
        }),
      );
    }
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(resolveTaskId(config, "zzzzzzzz")).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const message = errSpy.mock.calls[0]![0] as string;
    expect(message).toContain("no task found");
    expect(message).toContain("10 tasks searched");
    expect(message).toContain("capped");
    expect(message).toContain("full UUID");

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("exits 1 and lists every candidate when the prefix is ambiguous -- never guesses", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        tasks: [
          { id: "abcdef12-0000-0000-0000-000000000000", title: "First candidate", status: "open", priority: "LOW" },
          { id: "abcdef99-0000-0000-0000-000000000000", title: "Second candidate", status: "open", priority: "LOW" },
        ],
        nextCursor: null,
      }),
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(resolveTaskId(config, "abcdef")).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const message = errSpy.mock.calls[0]![0] as string;
    expect(message).toContain("ambiguous id prefix");
    expect(message).toContain("abcdef12-0000-0000-0000-000000000000");
    expect(message).toContain("First candidate");
    expect(message).toContain("abcdef99-0000-0000-0000-000000000000");
    expect(message).toContain("Second candidate");

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("converts a 400 from the search call into a CLI-level message naming prefix resolution as the failing step", async () => {
    // e.g. a multi-team human whose resolveTeamId 400s without an explicit
    // team id -- the raw `API error 400: ...` from the top-level handler
    // doesn't say it was prefix *resolution* that failed.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "bad_request", message: "teamId is required" }, 400),
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(resolveTaskId(config, "abcdef12")).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const message = errSpy.mock.calls[0]![0] as string;
    expect(message).toContain("prefix search failed");
    expect(message).toContain("full task UUID");

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
