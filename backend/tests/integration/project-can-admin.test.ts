/**
 * DB-backed tests for `canAdmin` on `GET /projects/:id`.
 *
 * `accessRole` reports the TEAM role first, so a team HUMAN_MEMBER or REVIEWER
 * who also holds a PROJECT_ADMIN grant on the project reports their team role
 * and the admin grant is invisible to a client that infers admin-ness from
 * `accessRole`. `canAdmin` is computed with the same check the workflow write
 * routes enforce (`isProjectAdmin`), and these tests run the real
 * authorization helpers and the real routes against Postgres to pin:
 *
 *   - which principal gets `canAdmin: true` (and which `accessRole` they see),
 *   - that `canAdmin` agrees with what a workflow write route actually allows
 *     for every principal, not just for the bug case.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";
import { groundingPostgres } from "../helpers/grounding-postgres.js";

const shared = vi.hoisted(() => ({ db: undefined as PrismaClient | undefined }));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_target, key) => {
        if (!shared.db) throw new Error("test database not connected");
        const value = Reflect.get(shared.db, key);
        return typeof value === "function" ? value.bind(shared.db) : value;
      },
    },
  ),
}));

vi.mock("../../src/services/audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/audit.js")>()),
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/board-default.js", () => ({
  ensureDefaultBoardForProject: vi.fn().mockResolvedValue(undefined),
}));

import { projectRouter } from "../../src/routes/projects.js";
import { workflowRouter } from "../../src/routes/workflows.js";

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
let teamId: string;
let projectId: string;

type Role = "ADMIN" | "HUMAN_MEMBER" | "REVIEWER";
type ProjectRole = "PROJECT_ADMIN" | "PROJECT_CONTRIBUTOR" | "PROJECT_VIEWER";

const humanActor = (userId: string): Actor => ({ type: "human", userId });

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("groundingRemoteTargetGuard", null);
    await next();
  });
  app.route("/", projectRouter);
  app.route("/", workflowRouter);
  return app;
}

async function getProject(actor: Actor) {
  const res = await makeApp(actor).request(`/projects/${projectId}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    project: { accessSource: string; accessRole: string | null; canAdmin: boolean };
  };
  return body.project;
}

// A workflow write route gated on `isProjectAdmin`. It forks the built-in
// default into a custom default row (201), so each call starts from a project
// without one.
async function customizeWorkflow(actor: Actor) {
  await db.workflow.deleteMany({ where: { projectId } });
  return makeApp(actor).request(`/projects/${projectId}/workflow/customize`, { method: "POST" });
}

async function seedUser(label: string) {
  const id = randomUUID();
  await db.user.create({ data: { id, login: `${label}-${id}`, name: label } });
  return id;
}

/** A user with an optional team role and an optional per-project grant. */
async function seedPrincipal(label: string, team: Role | null, project: ProjectRole | null) {
  const userId = await seedUser(label);
  if (team) await db.teamMember.create({ data: { teamId, userId, role: team } });
  if (project) {
    await db.projectMember.create({ data: { projectId, userId, role: project, invitedById: userId } });
  }
  return humanActor(userId);
}

beforeAll(async () => {
  store = await groundingPostgres();
  db = store.db;
  shared.db = db;
}, 60000);

afterAll(async () => {
  if (store) await store.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  teamId = randomUUID();
  await db.team.create({ data: { id: teamId, name: "CanAdmin", slug: randomUUID() } });
  projectId = randomUUID();
  await db.project.create({ data: { id: projectId, teamId, name: "CanAdmin", slug: randomUUID() } });
});

describe("GET /projects/:id canAdmin against Postgres", () => {
  it("team ADMIN: canAdmin true, accessRole ADMIN", async () => {
    const actor = await seedPrincipal("team-admin", "ADMIN", null);
    expect(await getProject(actor)).toMatchObject({ accessSource: "team", accessRole: "ADMIN", canAdmin: true });
  });

  it("team HUMAN_MEMBER who is also PROJECT_ADMIN: canAdmin true although accessRole stays the team role", async () => {
    // The bug case: the team role wins accessRole, the project admin grant is
    // invisible in it, yet the workflow write routes accept this principal.
    const actor = await seedPrincipal("member-pa", "HUMAN_MEMBER", "PROJECT_ADMIN");
    expect(await getProject(actor)).toMatchObject({ accessSource: "team", accessRole: "HUMAN_MEMBER", canAdmin: true });
  });

  it("team REVIEWER who is also PROJECT_ADMIN: canAdmin true although accessRole stays the team role", async () => {
    const actor = await seedPrincipal("reviewer-pa", "REVIEWER", "PROJECT_ADMIN");
    expect(await getProject(actor)).toMatchObject({ accessSource: "team", accessRole: "REVIEWER", canAdmin: true });
  });

  it("project-only PROJECT_ADMIN (no team membership): canAdmin true, accessRole PROJECT_ADMIN", async () => {
    const actor = await seedPrincipal("project-admin", null, "PROJECT_ADMIN");
    expect(await getProject(actor)).toMatchObject({ accessSource: "project", accessRole: "PROJECT_ADMIN", canAdmin: true });
  });

  it("team ADMIN who is also PROJECT_VIEWER: canAdmin true (the team role decides)", async () => {
    const actor = await seedPrincipal("admin-viewer", "ADMIN", "PROJECT_VIEWER");
    expect(await getProject(actor)).toMatchObject({ accessRole: "ADMIN", canAdmin: true });
  });

  it("team HUMAN_MEMBER without a project admin grant: canAdmin false", async () => {
    const actor = await seedPrincipal("member", "HUMAN_MEMBER", null);
    expect(await getProject(actor)).toMatchObject({ accessRole: "HUMAN_MEMBER", canAdmin: false });
  });

  it("team REVIEWER without a project admin grant: canAdmin false", async () => {
    const actor = await seedPrincipal("reviewer", "REVIEWER", null);
    expect(await getProject(actor)).toMatchObject({ accessRole: "REVIEWER", canAdmin: false });
  });

  it("team member who is also PROJECT_CONTRIBUTOR: canAdmin false", async () => {
    const actor = await seedPrincipal("member-contrib", "HUMAN_MEMBER", "PROJECT_CONTRIBUTOR");
    expect(await getProject(actor)).toMatchObject({ accessRole: "HUMAN_MEMBER", canAdmin: false });
  });

  it("project-only PROJECT_CONTRIBUTOR: canAdmin false", async () => {
    const actor = await seedPrincipal("project-contrib", null, "PROJECT_CONTRIBUTOR");
    expect(await getProject(actor)).toMatchObject({ accessSource: "project", accessRole: "PROJECT_CONTRIBUTOR", canAdmin: false });
  });

  it("project-only PROJECT_VIEWER: canAdmin false", async () => {
    const actor = await seedPrincipal("project-viewer", null, "PROJECT_VIEWER");
    expect(await getProject(actor)).toMatchObject({ accessSource: "project", accessRole: "PROJECT_VIEWER", canAdmin: false });
  });

  it("an agent token of the owning team: canAdmin false and no accessRole", async () => {
    const creator = await seedUser("token-owner");
    await db.teamMember.create({ data: { teamId, userId: creator, role: "ADMIN" } });
    const agent: Actor = { type: "agent", tokenId: randomUUID(), teamId, scopes: [], userId: creator };
    expect(await getProject(agent)).toMatchObject({ accessSource: "team", accessRole: null, canAdmin: false });
  });
});

describe("canAdmin agrees with the workflow write route", () => {
  it("the bug case (team HUMAN_MEMBER + PROJECT_ADMIN): GET says canAdmin and the write route answers 2xx", async () => {
    const actor = await seedPrincipal("member-pa", "HUMAN_MEMBER", "PROJECT_ADMIN");
    expect((await getProject(actor)).canAdmin).toBe(true);
    const res = await customizeWorkflow(actor);
    expect(res.status).toBe(201);
    expect(await db.workflow.count({ where: { projectId } })).toBe(1);
  });

  it("every principal: the write route is allowed exactly when GET reports canAdmin", async () => {
    const creator = await seedUser("token-owner");
    await db.teamMember.create({ data: { teamId, userId: creator, role: "ADMIN" } });
    const principals: Array<[string, Actor]> = [
      ["team ADMIN", await seedPrincipal("a1", "ADMIN", null)],
      ["team HUMAN_MEMBER + PROJECT_ADMIN", await seedPrincipal("a2", "HUMAN_MEMBER", "PROJECT_ADMIN")],
      ["team REVIEWER + PROJECT_ADMIN", await seedPrincipal("a3", "REVIEWER", "PROJECT_ADMIN")],
      ["project-only PROJECT_ADMIN", await seedPrincipal("a4", null, "PROJECT_ADMIN")],
      ["team HUMAN_MEMBER", await seedPrincipal("a5", "HUMAN_MEMBER", null)],
      ["team REVIEWER", await seedPrincipal("a6", "REVIEWER", null)],
      ["team member + PROJECT_CONTRIBUTOR", await seedPrincipal("a7", "HUMAN_MEMBER", "PROJECT_CONTRIBUTOR")],
      ["project-only PROJECT_CONTRIBUTOR", await seedPrincipal("a8", null, "PROJECT_CONTRIBUTOR")],
      ["project-only PROJECT_VIEWER", await seedPrincipal("a9", null, "PROJECT_VIEWER")],
      ["agent token", { type: "agent", tokenId: randomUUID(), teamId, scopes: [], userId: creator }],
    ];

    const seen = new Set<boolean>();
    for (const [label, actor] of principals) {
      const { canAdmin } = await getProject(actor);
      const res = await customizeWorkflow(actor);
      expect({ label, allowed: res.status === 201 }).toEqual({ label, allowed: canAdmin });
      if (!canAdmin) expect({ label, status: res.status }).toEqual({ label, status: 403 });
      seen.add(canAdmin);
    }
    // Both branches were exercised, so the equality above cannot hold vacuously.
    expect(seen).toEqual(new Set([true, false]));
  });
});
