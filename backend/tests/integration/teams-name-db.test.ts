/**
 * Team names against a real Postgres. The unit suites mock Prisma, so they
 * cannot show that a NUL byte stopped reaching the database: Postgres refuses
 * U+0000 in a text column and the route answered 500 internal_error. Both
 * write routes (POST /teams, PATCH /teams/:id) now answer 400 and nothing is
 * written; a name that is accepted round-trips through the database trimmed.
 */
import { type PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
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

  it("stores an accepted name trimmed, with accents and inner spaces intact", async () => {
    const created = await post("  Café  Team  ", "cafe-team");
    expect(created.status).toBe(201);
    expect((await pg.db.team.findUniqueOrThrow({ where: { slug: "cafe-team" } })).name).toBe("Café  Team");

    const renamed = await patch("  Renamed Über Team ");
    expect(renamed.status).toBe(200);
    expect((await pg.db.team.findUniqueOrThrow({ where: { id: teamId } })).name).toBe("Renamed Über Team");
  });
});
