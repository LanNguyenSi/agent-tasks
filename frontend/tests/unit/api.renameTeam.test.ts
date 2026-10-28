/**
 * Tests the REAL `renameTeam` api helper (no module mock): request shape (URL,
 * method, body, credentials), that the `{ team }` envelope is unwrapped to the
 * bare Team, and that a backend rejection surfaces as an `ApiRequestError`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createTeam, renameTeam, ApiRequestError, type Team } from "../../src/lib/api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const TEAM: Team = {
  id: "team-1",
  name: "Renamed",
  slug: "pandora",
  role: "ADMIN",
  createdAt: "2026-01-01T00:00:00Z",
};

describe("renameTeam", () => {
  it("PATCHes /api/teams/:id with only the name, credentials included, JSON content-type", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return { ok: true, status: 200, json: async () => ({ team: TEAM }) } as Response;
    }) as unknown as typeof fetch;

    await renameTeam("team-1", "Renamed");

    expect(seenUrl).toMatch(/\/api\/teams\/team-1$/);
    expect(seenInit?.method).toBe("PATCH");
    expect(seenInit?.credentials).toBe("include");
    expect((seenInit?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(seenInit?.body as string)).toEqual({ name: "Renamed" });
  });

  it("unwraps the { team } envelope", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ team: TEAM }),
    })) as unknown as typeof fetch;

    const result = await renameTeam("team-1", "Renamed");

    expect(result).toEqual(TEAM);
    expect((result as unknown as Record<string, unknown>).team).toBeUndefined();
  });

  it("surfaces a 403 as an ApiRequestError with the backend's code and message", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: "forbidden", message: "Only team admins can rename the team" }),
    })) as unknown as typeof fetch;

    await expect(renameTeam("team-1", "Nope")).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
      message: "Only team admins can rename the team",
    });
    await expect(renameTeam("team-1", "Nope")).rejects.toBeInstanceOf(ApiRequestError);
  });

  it("surfaces the name-rule message of a 400 as the error message", async () => {
    // The team routes add a top-level `message` to the shared validation body.
    globalThis.fetch = (async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        success: false,
        error: { issues: [{ message: "Team name must not be empty" }], name: "ZodError" },
        message: "Team name must not be empty",
      }),
    })) as unknown as typeof fetch;

    await expect(renameTeam("team-1", "\u200b")).rejects.toMatchObject({
      status: 400,
      message: "Team name must not be empty",
    });
    await expect(createTeam({ name: "\u200b", slug: "x" })).rejects.toMatchObject({
      status: 400,
      message: "Team name must not be empty",
    });
  });
});
