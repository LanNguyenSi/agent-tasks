/**
 * Client input that never reaches a route's own validation, against a real
 * Postgres. A malformed JSON body (Hono's JSON validator throws an
 * HTTPException) and a NUL byte in a path id (Postgres 22021 out of
 * findUnique) both answered 500 internal_error; both are client errors and
 * now answer 400 in the `{ error, message }` shape. The unit suites mock
 * Prisma, so only a real database shows that the NUL case is mapped.
 * A NUL nested inside a Json value (Postgres 22P05) and an unpaired UTF-16
 * surrogate (which Prisma refuses before the query is sent) answer 400 the
 * same way. The grounding routers have their own `onError`, whose catch-all is
 * 503, so they need the same refusal; a real grounding failure stays 503.
 * An unexpected server error still answers 500.
 */
import { type PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { groundingPostgres } from "../helpers/grounding-postgres.js";
import { appErrorHandler } from "../../src/lib/error-handler.js";
import type { AppVariables } from "../../src/types/hono.js";
import { createGroundingRouter } from "../../src/routes/grounding.js";
import { createGroundingMigrationRouter } from "../../src/routes/grounding-migration.js";
import { GroundingAttemptsService } from "../../src/services/grounding-attempts.js";
import { GroundingMigrationService } from "../../src/services/grounding-migration.js";

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
let taskId: string;

beforeAll(async () => {
  pg = await groundingPostgres();
  harness.db = pg.db;
  const user = await pg.db.user.create({ data: { login: "client-error-admin" } });
  userId = user.id;
  const team = await pg.db.team.create({ data: { name: "Original", slug: "original" } });
  teamId = team.id;
  await pg.db.teamMember.create({ data: { teamId, userId, role: "ADMIN" } });
  const project = await pg.db.project.create({ data: { teamId, name: "Client errors", slug: "client-errors" } });
  taskId = (await pg.db.task.create({ data: { projectId: project.id, title: "Original title" } })).id;
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

/** The refusal never echoes the driver's own text, only the fixed message. */
function expectFixedRefusal(text: string, message: string): void {
  expect(JSON.parse(text)).toEqual({ error: "validation_error", message });
  expect(text).not.toMatch(/22021|22P05|InvalidArg|Prisma|Postgres|ConnectorError|hex escape/iu);
}

describe("a NUL byte inside a Json value answers 400 (Postgres 22P05), not 500", () => {
  it("PATCH /tasks/:id with a NUL in templateData.goal", async () => {
    const res = await send("PATCH", `/api/tasks/${taskId}`, JSON.stringify({ templateData: { goal: "a\u0000b" } }));
    expect(res.status).toBe(400);
    expectFixedRefusal(await res.text(), "Request contains a character that cannot be stored (NUL byte in a JSON value)");
  });
});

describe("an unpaired surrogate in a non-team text field answers 400, not 500", () => {
  it("PATCH /tasks/:id with a lone leading surrogate in the title", async () => {
    const res = await send("PATCH", `/api/tasks/${taskId}`, JSON.stringify({ title: "broken \uD800 title" }));
    expect(res.status).toBe(400);
    expectFixedRefusal(
      await res.text(),
      "Request contains a character that cannot be stored (unpaired surrogate character)",
    );
  });
  it("POST /tasks/:id/comments with a lone trailing surrogate in the content", async () => {
    const res = await send("POST", `/api/tasks/${taskId}/comments`, JSON.stringify({ content: "broken \uDC00 comment" }));
    expect(res.status).toBe(400);
    expectFixedRefusal(
      await res.text(),
      "Request contains a character that cannot be stored (unpaired surrogate character)",
    );
  });
  it("keeps a well-formed surrogate pair (an emoji) a valid title", async () => {
    const res = await send("PATCH", `/api/tasks/${taskId}`, JSON.stringify({ title: "shipped \u{1F680} today" }));
    expect(res.status).toBe(200);
    expect((await pg.db.task.findUniqueOrThrow({ where: { id: taskId } })).title).toBe("shipped \u{1F680} today");
  });
});

describe("grounding routers", () => {
  /**
   * A real driver error for a NUL byte in a text value, taken from the real
   * database rather than handcrafted. The grounding services refuse a
   * non-UUID task id before any query and wrap everything else in their own
   * transaction retry, so the routers are shown the error through an
   * otherwise real service whose one method rejects with it.
   */
  async function nulByteError(): Promise<Error> {
    try {
      await pg.db.task.findUnique({ where: { id: "ab\u0000c" } });
    } catch (err) {
      return err as Error;
    }
    throw new Error("expected the database to refuse a NUL byte in a text value");
  }

  function groundingApp(failure: () => Promise<never>) {
    const service = new GroundingAttemptsService({ db: pg.db, config: { audience: "consumer.test", trust: () => [] } });
    vi.spyOn(service, "authorizeRouteIssue").mockImplementation(failure);
    const a = new Hono<{ Variables: AppVariables }>();
    a.use("*", async (c, next) => {
      c.set("actor", { type: "human", userId } as AppVariables["actor"]);
      await next();
    });
    a.route("/api", createGroundingRouter(service));
    a.onError(appErrorHandler);
    return a;
  }

  function migrationApp(failure: () => Promise<never>) {
    const service = new GroundingMigrationService({ db: pg.db, config: { audience: "consumer.test", trust: () => [] } });
    vi.spyOn(service, "execute").mockImplementation(failure);
    const a = new Hono<{ Variables: AppVariables }>();
    a.use("*", async (c, next) => {
      c.set("actor", { type: "human", userId } as AppVariables["actor"]);
      await next();
    });
    a.route("/api", createGroundingMigrationRouter(service));
    a.onError(appErrorHandler);
    return a;
  }

  const issue = (id: string) =>
    new Request(`http://localhost/api/tasks/${encodeURIComponent(id)}/grounding-attempts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "finish" }),
    });
  const migrate = () =>
    new Request(`http://localhost/api/tasks/${taskId}/grounding-migration`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "hold", key: "hold", reason: "Investigate compatibility", expectedRevision: 0 }),
    });

  it("answers 400 for a NUL byte in the grounding task id, not 503", async () => {
    const nul = await nulByteError();
    const res = await groundingApp(() => Promise.reject(nul)).fetch(issue("ab\u0000c"));
    expect(res.status).toBe(400);
    expectFixedRefusal(await res.text(), "Request contains a character that cannot be stored (NUL byte)");
  });
  it("keeps 503 for a genuine grounding failure on the grounding router", async () => {
    const res = await groundingApp(() => Promise.reject(new Error("grounding store unreachable"))).fetch(issue(taskId));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "grounding_verification_unavailable" });
  });
  it("answers 400 for a NUL byte in the grounding migration task id, not 503", async () => {
    const nul = await nulByteError();
    const res = await migrationApp(() => Promise.reject(nul)).fetch(migrate());
    expect(res.status).toBe(400);
    expectFixedRefusal(await res.text(), "Request contains a character that cannot be stored (NUL byte)");
  });
  it("keeps 503 for a genuine grounding failure on the migration router", async () => {
    const res = await migrationApp(() => Promise.reject(new Error("grounding store unreachable"))).fetch(migrate());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "grounding_verification_unavailable" });
  });
});

describe("unexpected errors", () => {
  it("still answer 500 internal_error", async () => {
    const res = await send("GET", "/api/boom");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error", message: "An unexpected error occurred" });
  });
});
