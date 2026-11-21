/**
 * The team sync prune and DELETE /projects/:id share one deletion service.
 * Both run against a real Postgres: a project whose tasks carry grounding
 * history (cohort, binding or operation rows, all `onDelete: Restrict`) or a
 * pending grounding operation must survive the prune and be reported, while
 * the other stale projects go and their attachment files are reclaimed.
 */
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";
import { groundingPostgres } from "../helpers/grounding-postgres.js";

const shared = vi.hoisted(() => ({
  db: undefined as PrismaClient | undefined,
  /** Runs once, right after the prune's candidate query returned. */
  afterCandidates: undefined as (() => Promise<void>) | undefined,
}));
const gh = vi.hoisted(() => ({ listUserRepos: vi.fn() }));
vi.mock("../../src/lib/prisma.js", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_t, key) => {
        const v = Reflect.get(shared.db!, key);
        if (key === "project") {
          const model = v as { findMany: (...args: unknown[]) => Promise<unknown> };
          return new Proxy(model, {
            get: (target, prop) => {
              if (prop !== "findMany") {
                const member = Reflect.get(target, prop);
                return typeof member === "function" ? member.bind(target) : member;
              }
              return async (...args: unknown[]) => {
                const rows = await target.findMany(...args);
                const hook = shared.afterCandidates;
                shared.afterCandidates = undefined;
                await hook?.();
                return rows;
              };
            },
          });
        }
        return typeof v === "function" ? v.bind(shared.db) : v;
      },
    },
  ),
}));
vi.mock("../../src/services/github-sync.js", () => ({ listUserRepos: gh.listUserRepos }));
vi.mock("../../src/services/audit.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/audit.js")>()),
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import { teamRouter } from "../../src/routes/teams.js";
import { projectRouter } from "../../src/routes/projects.js";
import { logAuditEvent } from "../../src/services/audit.js";

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
let uploadDirectory: string;
beforeAll(async () => {
  store = await groundingPostgres();
  db = store.db;
  shared.db = db;
}, 60000);
afterAll(async () => {
  if (store) await store.close();
});
beforeEach(async () => {
  gh.listUserRepos.mockReset();
  vi.mocked(logAuditEvent).mockClear();
  shared.afterCandidates = undefined;
  uploadDirectory = await mkdtemp(join(tmpdir(), "prune-safeguards-uploads-"));
  vi.stubEnv("UPLOAD_DIR", uploadDirectory);
});
afterEach(async () => {
  await rm(uploadDirectory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const repo = (full_name: string) => ({
  id: 1,
  name: full_name.split("/")[1]!,
  full_name,
  description: null,
  archived: false,
  disabled: false,
});

async function seedTeam(role: "ADMIN" | "HUMAN_MEMBER" = "ADMIN") {
  const userId = randomUUID();
  await db.user.create({ data: { id: userId, login: `u-${userId}`, name: "u", githubAccessToken: "gho_x" } });
  const team = await db.team.create({ data: { name: `t-${userId}`, slug: `t-${userId}` } });
  await db.teamMember.create({ data: { teamId: team.id, userId, role } });
  return { userId, teamId: team.id };
}
async function seedProject(teamId: string, githubRepo: string | null, id?: string) {
  const slug = randomUUID();
  return db.project.create({ data: { ...(id ? { id } : {}), teamId, name: slug, slug, githubRepo } });
}
async function seedTask(projectId: string, userId: string) {
  return db.task.create({ data: { projectId, title: "task", createdByUserId: userId } });
}
async function seedAttachment(taskId: string, userId: string) {
  const filename = `${randomUUID()}.txt`;
  const path = join(uploadDirectory, filename);
  await writeFile(path, "attachment bytes\n");
  await db.taskAttachment.create({
    data: { taskId, name: filename, url: `/uploads/${filename}`, mimeType: "text/plain", sizeBytes: 17, createdByUserId: userId },
  });
  return path;
}
const exists = (path: string) => access(path).then(() => true, () => false);

type History = "cohort" | "binding" | "operation";
/** Grounding history rows on a task: any one of them keeps the project. */
async function retain(taskId: string, projectId: string, kind: History) {
  if (kind === "cohort") {
    await db.groundingCohort.create({ data: { taskId, projectId, mode: "EXTERNAL_V1", protected: true, provenance: "test" } });
  } else if (kind === "binding") {
    await db.groundingBinding.create({
      data: { taskId, projectId, audience: "consumer.test", subjectMode: "TASK_SPEC", policyId: "p", policyRevision: "1", policySha256: "a".repeat(64) },
    });
  } else {
    await db.groundingOperation.create({
      data: { id: randomUUID(), taskId, key: randomUUID(), actorType: "agent", actorId: "test-agent", fingerprint: "a".repeat(64), request: {}, decision: {}, state: "COMPLETED" },
    });
  }
}
/** A cohort whose reservation points at an operation that is still being finalized. */
async function reserve(taskId: string, projectId: string, state: "RESERVED" | "DISPATCHED") {
  await retain(taskId, projectId, "cohort");
  const operation = await db.groundingOperation.create({
    data: { id: randomUUID(), taskId, key: randomUUID(), actorType: "agent", actorId: "test-agent", fingerprint: "a".repeat(64), request: {}, decision: {}, state },
  });
  await db.groundingCohort.update({ where: { taskId }, data: { reservationId: operation.id } });
}

function appFor(userId: string) {
  const app = new Hono<{ Variables: AppVariables }>();
  const actor: Actor = { type: "human", userId };
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", teamRouter);
  app.route("/", projectRouter);
  return app;
}
async function sync(userId: string, teamId: string) {
  const res = await appFor(userId).request(`/teams/${teamId}/sync`, { method: "POST" });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const ids = (teamId: string) => db.project.findMany({ where: { teamId }, select: { id: true } }).then((rows) => rows.map((r) => r.id).sort());

describe("sync prune keeps projects the deletion safeguards protect", () => {
  it.each<History>(["cohort", "binding", "operation"])(
    "a stale project whose task has a %s row is kept and reported, the other stale project is deleted, the request stays 200",
    async (kind) => {
      const { userId, teamId } = await seedTeam();
      const keep = await seedProject(teamId, "LanNguyenSi/here");
      const retained = await seedProject(teamId, "lannguyensi/retired-kept");
      const gone = await seedProject(teamId, "lannguyensi/retired-gone");
      await retain((await seedTask(retained.id, userId)).id, retained.id, kind);
      gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/here")]);

      const r = await sync(userId, teamId);

      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        pruned: 1,
        pruneDeferred: false,
        pruneRetained: [{ projectId: retained.id, reason: "grounding_history_retained" }],
      });
      expect(String(r.body.message)).toContain("1 stale project was kept");
      expect(await ids(teamId)).toEqual([keep.id, retained.id].sort());
      expect(await db.project.findUnique({ where: { id: gone.id } })).toBeNull();
      expect(logAuditEvent).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logAuditEvent).mock.calls[0]![0]).toMatchObject({
        action: "project.synced",
        actorId: userId,
        payload: {
          teamId,
          via: "team_sync_prune",
          deletedProjectIds: [gone.id],
          deletedCount: 1,
          skippedProjects: [{ projectId: retained.id, reason: "grounding_history_retained" }],
        },
      });
    },
  );

  it.each(["RESERVED", "DISPATCHED"] as const)(
    "a stale project with a %s grounding operation is kept as pending, which wins over its retained history",
    async (state) => {
      const { userId, teamId } = await seedTeam();
      await seedProject(teamId, "LanNguyenSi/here");
      const pending = await seedProject(teamId, "lannguyensi/retired-pending");
      await reserve((await seedTask(pending.id, userId)).id, pending.id, state);
      gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/here")]);

      const r = await sync(userId, teamId);

      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        pruned: 0,
        pruneRetained: [{ projectId: pending.id, reason: "grounding_finalization_pending" }],
      });
      expect(await db.project.findUnique({ where: { id: pending.id } })).not.toBeNull();
      expect(vi.mocked(logAuditEvent).mock.calls[0]![0]).toMatchObject({
        payload: { deletedProjectIds: [], deletedCount: 0, skippedProjects: [{ projectId: pending.id, reason: "grounding_finalization_pending" }] },
      });
    },
  );

  it("history wins over an active repository fence: the project is reported as kept, not deferred", async () => {
    const { userId, teamId } = await seedTeam();
    await seedProject(teamId, "LanNguyenSi/here");
    const retained = await seedProject(teamId, "lannguyensi/retired-fenced-kept");
    await retain((await seedTask(retained.id, userId)).id, retained.id, "cohort");
    const intentId = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO grounding_github_fence_intents (id, repo, kind, state) VALUES ('${intentId}', 'lannguyensi/retired-fenced-kept', 'MERGE', 'ACTIVE')`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO grounding_github_repository_fences (repo, version, "ownerId") VALUES ('lannguyensi/retired-fenced-kept', 1, '${intentId}') ON CONFLICT (repo) DO UPDATE SET "ownerId" = EXCLUDED."ownerId"`,
    );
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/here")]);

    const r = await sync(userId, teamId);

    expect(r.body).toMatchObject({
      pruned: 0,
      pruneDeferred: false,
      pruneRetained: [{ projectId: retained.id, reason: "grounding_history_retained" }],
    });
  });

  it("a stale project with grounding history among tasks without any is kept whole: every task and attachment stays", async () => {
    const { userId, teamId } = await seedTeam();
    await seedProject(teamId, "LanNguyenSi/here");
    const retained = await seedProject(teamId, "lannguyensi/retired-mixed");
    const plain = await seedTask(retained.id, userId);
    await retain((await seedTask(retained.id, userId)).id, retained.id, "cohort");
    const file = await seedAttachment(plain.id, userId);
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/here")]);

    const r = await sync(userId, teamId);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ pruned: 0 });
    expect(await db.task.count({ where: { projectId: retained.id } })).toBe(2);
    expect(await exists(file)).toBe(true);
  });

  it("a non-admin prunes nothing, reports nothing kept, and leaves a retained project alone", async () => {
    const { teamId } = await seedTeam("ADMIN");
    const member = randomUUID();
    await db.user.create({ data: { id: member, login: `m-${member}`, name: "m", githubAccessToken: "gho_m" } });
    await db.teamMember.create({ data: { teamId, userId: member, role: "HUMAN_MEMBER" } });
    const retained = await seedProject(teamId, "lannguyensi/retired-na");
    await retain((await seedTask(retained.id, member)).id, retained.id, "cohort");
    const plain = await seedProject(teamId, "lannguyensi/retired-plain-na");
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/here-na")]);

    const r = await sync(member, teamId);

    expect(r.body).toMatchObject({ pruned: 0, pruneRetained: [], pruneSkipped: "not_admin" });
    expect(await db.project.findUnique({ where: { id: retained.id } })).not.toBeNull();
    expect(await db.project.findUnique({ where: { id: plain.id } })).not.toBeNull();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });
});

/** History the explicit check does not list: only a Restrict foreign key keeps the project. */
type ForeignKeyHistory = "observation" | "migrationCommand" | "migrationState";
async function holdByForeignKey(taskId: string, projectId: string, kind: ForeignKeyHistory) {
  if (kind === "observation") {
    const deliveryId = randomUUID();
    await db.groundingGithubWebhookDelivery.create({ data: { deliveryId, event: "push", fingerprint: "f" } });
    await db.groundingGithubObservation.create({
      data: { deliveryId, taskId, repo: "lannguyensi/retired", event: "push", matchKind: "task", state: "seen", reason: "test" },
    });
  } else if (kind === "migrationCommand") {
    await db.groundingMigrationCommand.create({
      data: { taskId, key: randomUUID(), actorId: "a", fingerprint: "f", request: {}, before: {}, after: {}, result: {} },
    });
  } else {
    await db.groundingMigrationState.create({ data: { taskId, projectId, held: false, revision: 0 } });
  }
}

describe("a project held only by a Restrict foreign key outside cohort, binding and operation", () => {
  it.each<ForeignKeyHistory>(["observation", "migrationCommand", "migrationState"])(
    "the prune keeps it as retained (%s row), deletes the others and stays 200; DELETE answers the retained 409",
    async (kind) => {
      const { userId, teamId } = await seedTeam();
      await seedProject(teamId, "LanNguyenSi/here");
      const held = await seedProject(teamId, "lannguyensi/retired-held");
      const gone = await seedProject(teamId, "lannguyensi/retired-gone");
      const file = await seedAttachment((await seedTask(held.id, userId)).id, userId);
      await holdByForeignKey((await db.task.findFirstOrThrow({ where: { projectId: held.id } })).id, held.id, kind);
      gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/here")]);

      const r = await sync(userId, teamId);

      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        pruned: 1,
        pruneDeferred: false,
        pruneRetained: [{ projectId: held.id, reason: "grounding_history_retained" }],
      });
      expect(await db.project.findUnique({ where: { id: held.id } })).not.toBeNull();
      expect(await db.project.findUnique({ where: { id: gone.id } })).toBeNull();
      expect(await exists(file)).toBe(true);
      expect(vi.mocked(logAuditEvent).mock.calls[0]![0]).toMatchObject({
        payload: { deletedProjectIds: [gone.id], skippedProjects: [{ projectId: held.id, reason: "grounding_history_retained" }] },
      });

      const res = await appFor(userId).request(`/projects/${held.id}`, { method: "DELETE" });
      expect({ status: res.status, body: await res.json() }).toEqual({ status: 409, body: { error: "grounding_history_retained" } });
      expect(await db.project.findUnique({ where: { id: held.id } })).not.toBeNull();
      expect(await exists(file)).toBe(true);
    },
  );
});

describe("a delete error that is not a foreign-key restriction is not swallowed", () => {
  async function failDeleteOf(projectId: string) {
    await db.$executeRawUnsafe(
      `CREATE FUNCTION fail_project_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test delete failure'; END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER fail_project_delete BEFORE DELETE ON projects FOR EACH ROW WHEN (OLD.id = '${projectId}') EXECUTE FUNCTION fail_project_delete()`,
    );
  }
  async function restoreDelete() {
    await db.$executeRawUnsafe("DROP TRIGGER fail_project_delete ON projects");
    await db.$executeRawUnsafe("DROP FUNCTION fail_project_delete()");
  }

  it("the sync fails with a server error, the project stays, nothing is reported as kept", async () => {
    const { userId, teamId } = await seedTeam();
    await seedProject(teamId, "LanNguyenSi/here");
    const broken = await seedProject(teamId, "lannguyensi/retired-broken");
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/here")]);
    await failDeleteOf(broken.id);
    try {
      const res = await appFor(userId).request(`/teams/${teamId}/sync`, { method: "POST" });
      expect(res.status).toBe(500);
    } finally {
      await restoreDelete();
    }
    expect(await db.project.findUnique({ where: { id: broken.id } })).not.toBeNull();
  });

  it("projects before the failing one are deleted in id order, the rest stay, and the audit event names the deleted ones", async () => {
    const { userId, teamId } = await seedTeam();
    await seedProject(teamId, "LanNguyenSi/here");
    // Created in descending id order, so the database's natural order differs from the sorted one.
    const [high, middle, low] = [randomUUID(), randomUUID(), randomUUID()].sort().reverse() as [string, string, string];
    for (const id of [high, middle, low]) await seedProject(teamId, `lannguyensi/retired-${id}`, id);
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/here")]);
    await failDeleteOf(middle);
    try {
      const res = await appFor(userId).request(`/teams/${teamId}/sync`, { method: "POST" });
      expect(res.status).toBe(500);
    } finally {
      await restoreDelete();
    }
    expect(await db.project.findUnique({ where: { id: low } })).toBeNull();
    expect(await db.project.findUnique({ where: { id: middle } })).not.toBeNull();
    expect(await db.project.findUnique({ where: { id: high } })).not.toBeNull();
    expect(vi.mocked(logAuditEvent).mock.calls[0]![0]).toMatchObject({
      payload: { candidateProjectIds: [low, middle, high], deletedProjectIds: [low], deletedCount: 1 },
    });
  });
});

describe("a fenced stale project is named in the audit event", () => {
  it("deferredProjectIds lists the fenced project next to the deleted one", async () => {
    const { userId, teamId } = await seedTeam();
    await seedProject(teamId, "LanNguyenSi/here");
    const fenced = await seedProject(teamId, "lannguyensi/retired-fenced-audit");
    const free = await seedProject(teamId, "lannguyensi/retired-free-audit");
    const intentId = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO grounding_github_fence_intents (id, repo, kind, state) VALUES ('${intentId}', 'lannguyensi/retired-fenced-audit', 'MERGE', 'ACTIVE')`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO grounding_github_repository_fences (repo, version, "ownerId") VALUES ('lannguyensi/retired-fenced-audit', 1, '${intentId}') ON CONFLICT (repo) DO UPDATE SET "ownerId" = EXCLUDED."ownerId"`,
    );
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/here")]);

    const r = await sync(userId, teamId);

    expect(r.body).toMatchObject({ pruned: 1, pruneDeferred: true });
    expect(vi.mocked(logAuditEvent).mock.calls[0]![0]).toMatchObject({
      payload: { deletedProjectIds: [free.id], deferredProjectIds: [fenced.id] },
    });
  });
});

describe("sync prune reclaims attachment files", () => {
  it("removes the stored file of a pruned project and keeps the file of a kept project", async () => {
    const { userId, teamId } = await seedTeam();
    await seedProject(teamId, "LanNguyenSi/here");
    const gone = await seedProject(teamId, "lannguyensi/retired-gone");
    const kept = await seedProject(teamId, "lannguyensi/retired-kept");
    const goneFile = await seedAttachment((await seedTask(gone.id, userId)).id, userId);
    const keptTask = await seedTask(kept.id, userId);
    const keptFile = await seedAttachment(keptTask.id, userId);
    await retain(keptTask.id, kept.id, "cohort");
    const keepProject = await db.project.findFirstOrThrow({ where: { teamId, githubRepo: "LanNguyenSi/here" } });
    const keepFile = await seedAttachment((await seedTask(keepProject.id, userId)).id, userId);
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/here")]);

    const r = await sync(userId, teamId);

    expect(r.body).toMatchObject({ pruned: 1 });
    expect(await exists(goneFile)).toBe(false);
    expect(await exists(keptFile)).toBe(true);
    expect(await exists(keepFile)).toBe(true);
  });

  it("a pruned project's link attachment (no stored file) and a missing file do not fail the sync", async () => {
    const { userId, teamId } = await seedTeam();
    await seedProject(teamId, "LanNguyenSi/here");
    const gone = await seedProject(teamId, "lannguyensi/retired-links");
    const task = await seedTask(gone.id, userId);
    await db.taskAttachment.create({ data: { taskId: task.id, name: "link", url: "https://example.test/x", createdByUserId: userId } });
    const file = await seedAttachment(task.id, userId);
    await rm(file);
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/here")]);

    const r = await sync(userId, teamId);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ pruned: 1 });
  });
});

describe("sync prune re-checks each project inside its transaction", () => {
  it("a project rebound to a listed repo in another letter case after the candidates were picked is not deleted", async () => {
    const { userId, teamId } = await seedTeam();
    await seedProject(teamId, "LanNguyenSi/here");
    const raced = await seedProject(teamId, "lannguyensi/retired-raced");
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/here")]);
    shared.afterCandidates = async () => {
      await db.project.update({ where: { id: raced.id }, data: { githubRepo: "LANNGUYENSI/HERE" } });
    };

    const r = await sync(userId, teamId);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ pruned: 0, pruneRetained: [] });
    expect(await db.project.findUnique({ where: { id: raced.id } })).not.toBeNull();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it("a project unbound after the candidates were picked is not deleted", async () => {
    const { userId, teamId } = await seedTeam();
    await seedProject(teamId, "LanNguyenSi/here");
    const raced = await seedProject(teamId, "lannguyensi/retired-unbound");
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/here")]);
    shared.afterCandidates = async () => {
      await db.project.update({ where: { id: raced.id }, data: { githubRepo: null } });
    };

    const r = await sync(userId, teamId);

    expect(r.body).toMatchObject({ pruned: 0 });
    expect(await db.project.findUnique({ where: { id: raced.id } })).not.toBeNull();
  });

  it("a project moved to another team after the candidates were picked is not deleted", async () => {
    const { userId, teamId } = await seedTeam();
    const other = await seedTeam();
    await seedProject(teamId, "LanNguyenSi/here");
    const raced = await seedProject(teamId, "lannguyensi/retired-moved");
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/here")]);
    shared.afterCandidates = async () => {
      await db.project.update({ where: { id: raced.id }, data: { teamId: other.teamId } });
    };

    const r = await sync(userId, teamId);

    expect(r.body).toMatchObject({ pruned: 0 });
    expect(await db.project.findUnique({ where: { id: raced.id } })).toMatchObject({ teamId: other.teamId });
  });

  it("a project deleted by someone else after the candidates were picked is skipped without failing the sync", async () => {
    const { userId, teamId } = await seedTeam();
    await seedProject(teamId, "LanNguyenSi/here");
    const raced = await seedProject(teamId, "lannguyensi/retired-vanished");
    const other = await seedProject(teamId, "lannguyensi/retired-other");
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/here")]);
    shared.afterCandidates = async () => {
      await db.project.delete({ where: { id: raced.id } });
    };

    const r = await sync(userId, teamId);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ pruned: 1, pruneRetained: [] });
    expect(await db.project.findUnique({ where: { id: other.id } })).toBeNull();
    expect(vi.mocked(logAuditEvent).mock.calls[0]![0]).toMatchObject({
      payload: { candidateProjectIds: expect.arrayContaining([raced.id, other.id]), deletedProjectIds: [other.id], deletedCount: 1 },
    });
  });

  it("a stale project whose binding differs from a listed repo only in letter case is never a candidate", async () => {
    const { userId, teamId } = await seedTeam();
    const cased = await seedProject(teamId, "lannguyensi/here");
    gh.listUserRepos.mockResolvedValue([repo("LanNguyenSi/here")]);

    const r = await sync(userId, teamId);

    expect(r.body).toMatchObject({ pruned: 0, pruneRetained: [] });
    expect(await db.project.findUnique({ where: { id: cased.id } })).not.toBeNull();
  });
});

describe("DELETE /projects/:id on the shared deletion service", () => {
  const del = async (userId: string, projectId: string) => {
    const res = await appFor(userId).request(`/projects/${projectId}`, { method: "DELETE" });
    const text = await res.text();
    return { status: res.status, body: (text.startsWith("{") ? JSON.parse(text) : { text }) as Record<string, unknown> };
  };

  it("deletes a plain project for a team admin and removes its stored file", async () => {
    const { userId, teamId } = await seedTeam();
    const project = await seedProject(teamId, null);
    const file = await seedAttachment((await seedTask(project.id, userId)).id, userId);

    expect(await del(userId, project.id)).toEqual({ status: 200, body: { success: true } });
    expect(await db.project.findUnique({ where: { id: project.id } })).toBeNull();
    expect(await exists(file)).toBe(false);
  });

  it.each<History>(["cohort", "binding", "operation"])("answers 409 grounding_history_retained and keeps everything for a task with a %s row", async (kind) => {
    const { userId, teamId } = await seedTeam();
    const project = await seedProject(teamId, null);
    const task = await seedTask(project.id, userId);
    const file = await seedAttachment(task.id, userId);
    await retain(task.id, project.id, kind);

    expect(await del(userId, project.id)).toEqual({ status: 409, body: { error: "grounding_history_retained" } });
    expect(await db.project.findUnique({ where: { id: project.id } })).not.toBeNull();
    expect(await exists(file)).toBe(true);
  });

  it("answers 409 grounding_finalization_pending for a pending operation, before the retention refusal", async () => {
    const { userId, teamId } = await seedTeam();
    const project = await seedProject(teamId, null);
    await reserve((await seedTask(project.id, userId)).id, project.id, "RESERVED");

    expect(await del(userId, project.id)).toEqual({ status: 409, body: { error: "grounding_finalization_pending" } });
    expect(await db.project.findUnique({ where: { id: project.id } })).not.toBeNull();
  });

  it("answers 403 to a team member who is not an admin, and keeps project and file", async () => {
    const { teamId } = await seedTeam();
    const member = randomUUID();
    await db.user.create({ data: { id: member, login: `m-${member}`, name: "m" } });
    await db.teamMember.create({ data: { teamId, userId: member, role: "HUMAN_MEMBER" } });
    const project = await seedProject(teamId, null);
    const file = await seedAttachment((await seedTask(project.id, member)).id, member);

    expect(await del(member, project.id)).toEqual({
      status: 403,
      body: { error: "forbidden", message: "Only project admins can delete projects" },
    });
    expect(await db.project.findUnique({ where: { id: project.id } })).not.toBeNull();
    expect(await exists(file)).toBe(true);
  });

  it("an active repository fence on the project's repo refuses the delete as a server error and keeps project and file", async () => {
    const { userId, teamId } = await seedTeam();
    const project = await seedProject(teamId, "lannguyensi/fenced-delete");
    const file = await seedAttachment((await seedTask(project.id, userId)).id, userId);
    const intentId = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO grounding_github_fence_intents (id, repo, kind, state) VALUES ('${intentId}', 'lannguyensi/fenced-delete', 'MERGE', 'ACTIVE')`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO grounding_github_repository_fences (repo, version, "ownerId") VALUES ('lannguyensi/fenced-delete', 1, '${intentId}') ON CONFLICT (repo) DO UPDATE SET "ownerId" = EXCLUDED."ownerId"`,
    );

    const r = await del(userId, project.id);

    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(await db.project.findUnique({ where: { id: project.id } })).not.toBeNull();
    expect(await exists(file)).toBe(true);
  });

  it("answers 404 for an unknown and for a malformed project id", async () => {
    const { userId } = await seedTeam();

    expect((await del(userId, randomUUID())).status).toBe(404);
    expect((await del(userId, "not-a-guid")).status).toBe(404);
  });
});
