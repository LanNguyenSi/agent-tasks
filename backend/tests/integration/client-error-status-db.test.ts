/**
 * Client input that never reaches a route's own validation, against a real
 * Postgres. A malformed JSON body (Hono's JSON validator throws an
 * HTTPException) and a NUL byte in a path id (Postgres 22021 out of
 * findUnique) both answered 500 internal_error; both are client errors and
 * now answer 400 in the `{ error, message }` shape. The unit suites mock
 * Prisma, so only a real database shows that the NUL case is mapped.
 * An unexpected server error still answers 500.
 */
import { type PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { groundingPostgres } from "../helpers/grounding-postgres.js";
import { appErrorHandler } from "../../src/lib/error-handler.js";
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
import { taskRouter } from "../../src/routes/tasks.js";

let pg: Awaited<ReturnType<typeof groundingPostgres>>;
let userId: string;
let teamId: string;

beforeAll(async () => {
  pg = await groundingPostgres();
  harness.db = pg.db;
  const user = await pg.db.user.create({ data: { login: "client-error-admin" } });
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
  a.route("/api", taskRouter);
  a.get("/api/boom", () => {
    throw new Error("unexpected");
  });
  a.onError(appErrorHandler);
  return a;
}

function send(method: string, path: string, body?: string) {
  return app().request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body,
  });
}

const MALFORMED = '{"name":';

describe("malformed JSON body answers 400, not 500", () => {
  it.each([
    ["POST /teams", "POST", "/api/teams"],
    ["PATCH /teams/:id", "PATCH", `/api/teams/${"TEAM"}`],
    ["POST /tasks/:id/respec", "POST", "/api/tasks/some-task/respec"],
  ])("%s", async (_label, method, path) => {
    const res = await send(method, path.replace("TEAM", teamId), MALFORMED);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_error", message: "Malformed JSON in request body" });
  });
});

describe("a NUL byte in a path id answers 400, not 500", () => {
  it.each([
    ["PATCH /teams/:id", "PATCH", "/api/teams/ab%00c", JSON.stringify({ name: "Ok" })],
    ["GET /tasks/:id", "GET", "/api/tasks/ab%00c", undefined],
    ["PATCH /tasks/:id", "PATCH", "/api/tasks/ab%00c", JSON.stringify({ title: "Ok" })],
  ])("%s", async (_label, method, path, body) => {
    const res = await send(method, path, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "validation_error",
      message: "Request contains a character that cannot be stored (NUL byte)",
    });
  });

});

describe("unexpected errors", () => {
  it("still answer 500 internal_error", async () => {
    const res = await send("GET", "/api/boom");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error", message: "An unexpected error occurred" });
  });
});
