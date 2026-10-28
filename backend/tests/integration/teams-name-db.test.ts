/**
 * Team names against a real Postgres. The unit suites mock Prisma, so they
 * cannot show that a NUL byte stopped reaching the database: Postgres refuses
 * U+0000 in a text column and the route answered 500 internal_error. Both
 * write routes (POST /teams, PATCH /teams/:id) now answer 400 and nothing is
 * written; the same holds for an unpaired UTF-16 surrogate (Prisma refuses it
 * before the query, which also surfaced as a 500). A name that is accepted
 * round-trips through the database trimmed. The England subdivision flag
 * (U+1F3F4, tag letters, U+E007F) is accepted and stored unchanged; a mark
 * stack split by zero-width joiners is still refused.
 */
import { type PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { groundingPostgres } from "../helpers/grounding-postgres.js";
import type { AppVariables } from "../../src/types/hono.js";

const harness = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock("../../src/lib/prisma.js", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_t, p) => {
        const v = Reflect.get(harness.db!, p);
        return typeof v === "function" ? v.bind(harness.db) : v;
      },
    },
  ),
}));
import { teamRouter } from "../../src/routes/teams.js";
import {
  TEAM_NAME_EMPTY_MESSAGE,
  TEAM_NAME_INVISIBLE_MESSAGE,
  TEAM_NAME_MARKS_MESSAGE,
} from "../../src/lib/team-name.js";

let pg: Awaited<ReturnType<typeof groundingPostgres>>;
let userId: string;
let teamId: string;

beforeAll(async () => {
  pg = await groundingPostgres();
  harness.db = pg.db;
  const user = await pg.db.user.create({ data: { login: "team-name-admin" } });
  userId = user.id;
  const team = await pg.db.team.create({ data: { name: "Original", slug: "original" } });
  teamId = team.id;
  await pg.db.teamMember.create({ data: { teamId, userId, role: "ADMIN" } });
}, 60000);
afterAll(async () => {
  await pg?.close();
});
afterEach(async () => {
  // Every row PATCHes the same team, so reset its name: a class that leaks
  // must fail its own row only, never the rows that come after it.
  await pg?.db.team.update({ where: { id: teamId }, data: { name: "Original" } });
});

/** A row's own slug: lowercase a-z, 0-9 and dashes, derived from its label. */
function rowSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function app() {
  const a = new Hono<{ Variables: AppVariables }>();
  a.use("*", async (c, next) => {
    c.set("actor", { type: "human", userId } as AppVariables["actor"]);
    await next();
  });
  a.route("/api", teamRouter);
  return a;
}

function post(name: string, slug: string) {
  return app().request("/api/teams", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, slug }),
  });
}

function patch(name: string) {
  return app().request(`/api/teams/${teamId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

describe("team names (real database)", () => {
  it("POST /teams answers 400, not 500, for a NUL byte and creates no team", async () => {
    const res = await post("Bad\u0000Name", "nul-team");
    expect(res.status).toBe(400);
    expect(await pg.db.team.findUnique({ where: { slug: "nul-team" } })).toBeNull();
  });

  it("PATCH /teams/:id answers 400, not 500, for a NUL byte and keeps the name", async () => {
    const res = await patch("Bad\u0000Name");
    expect(res.status).toBe(400);
    expect((await pg.db.team.findUniqueOrThrow({ where: { id: teamId } })).name).toBe("Original");
  });

  it.each([
    ["a high surrogate inside the name", "A\ud800B"],
    ["a lone high surrogate", "\ud800"],
    ["a lone low surrogate before text", "\udc00x"],
  ])("answers 400, not 500, for %s on both routes and writes nothing", async (_label, name) => {
    const created = await post(name, "surrogate-team");
    expect(created.status).toBe(400);
    expect(await pg.db.team.findUnique({ where: { slug: "surrogate-team" } })).toBeNull();

    const renamed = await patch(name);
    expect(renamed.status).toBe(400);
    expect((await pg.db.team.findUniqueOrThrow({ where: { id: teamId } })).name).toBe("Original");
  });

  it.each([
    ["Hangul filler U+3164", "\u3164"],
    ["braille blank U+2800", "\u2800"],
    ["combining mark only", "\u0301"],
    ["variation selector only", "\ufe0f"],
    ["private use U+E000", "\ue000"],
    ["noncharacter U+FFFE", "\ufffe"],
    ["bidi override inside a name", "abc\u202edef"],
    ["line separator inside a name", "a\u2028b"],
  ])("answers 400 for %s on both routes and writes nothing", async (_label, name) => {
    const created = await post(name, "invisible-team");
    expect(created.status).toBe(400);
    expect(await pg.db.team.findUnique({ where: { slug: "invisible-team" } })).toBeNull();

    const renamed = await patch(name);
    expect(renamed.status).toBe(400);
    expect((await pg.db.team.findUniqueOrThrow({ where: { id: teamId } })).name).toBe("Original");
  });

  it.each([
    ["tag character U+E0020 inside a name", "Team\u{e0020}Name", TEAM_NAME_INVISIBLE_MESSAGE],
    ["tag characters carrying an ASCII payload", "Team\u{e0021}\u{e0034}\u{e002d}Name", TEAM_NAME_INVISIBLE_MESSAGE],
    ["a name that is only a tag character", "\u{e0020}", TEAM_NAME_INVISIBLE_MESSAGE],
    ["the left-to-right mark U+200E", "Team\u200eName", TEAM_NAME_INVISIBLE_MESSAGE],
    ["the right-to-left mark U+200F", "Team\u200fName", TEAM_NAME_INVISIBLE_MESSAGE],
    ["the Arabic letter mark U+061C", "Team\u061cName", TEAM_NAME_INVISIBLE_MESSAGE],
    ["interlinear annotation U+FFF9-U+FFFB", "Team\u{fff9}a\u{fffb}Name", TEAM_NAME_INVISIBLE_MESSAGE],
    ["invisible operator U+2061", "Team\u2061Name", TEAM_NAME_INVISIBLE_MESSAGE],
    ["unassigned code point U+0378", "Team\u0378Name", TEAM_NAME_INVISIBLE_MESSAGE],
    ["9 combining marks on one letter", `Team Nguy${"e\u0301\u0302\u0303\u0304\u0305\u0306\u0307\u0308\u0309"}n`, TEAM_NAME_MARKS_MESSAGE],
    [
      "40 marks in one cluster split by zero-width joiners",
      `Team ${`a${"\u0301\u0302\u0303\u0304\u200d".repeat(10)}`}`,
      TEAM_NAME_MARKS_MESSAGE,
    ],
    ["U+FFFC alone", "\ufffc", TEAM_NAME_EMPTY_MESSAGE],
  ] as const)(
    "answers 400 with the rule message for %s on both routes and writes nothing",
    async (label, name, message) => {
      const slug = rowSlug(label);
      const created = await post(name, slug);
      expect(created.status).toBe(400);
      expect((await created.json() as { message: string }).message).toBe(message);
      expect(await pg.db.team.findUnique({ where: { slug } })).toBeNull();

      const renamed = await patch(name);
      expect(renamed.status).toBe(400);
      expect((await renamed.json() as { message: string }).message).toBe(message);
      expect((await pg.db.team.findUniqueOrThrow({ where: { id: teamId } })).name).toBe("Original");
    },
  );

  it("accepts the England subdivision flag on both routes and stores it unchanged", async () => {
    const flag = "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}";
    const created = await post(`Team ${flag}`, "england-flag-team");
    expect(created.status).toBe(201);
    expect((await pg.db.team.findUniqueOrThrow({ where: { slug: "england-flag-team" } })).name).toBe(`Team ${flag}`);

    const renamed = await patch(flag);
    expect(renamed.status).toBe(200);
    expect((await pg.db.team.findUniqueOrThrow({ where: { id: teamId } })).name).toBe(flag);
  });

  it("stores an accepted name trimmed, with accents and inner spaces intact", async () => {
    const created = await post("  Café  Team  ", "cafe-team");
    expect(created.status).toBe(201);
    expect((await pg.db.team.findUniqueOrThrow({ where: { slug: "cafe-team" } })).name).toBe("Café  Team");

    const renamed = await patch("  Renamed Über Team ");
    expect(renamed.status).toBe(200);
    expect((await pg.db.team.findUniqueOrThrow({ where: { id: teamId } })).name).toBe("Renamed Über Team");
  });
});
