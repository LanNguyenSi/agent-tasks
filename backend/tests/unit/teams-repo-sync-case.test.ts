/**
 * POST /teams/:id/sync: the GitHub repo sync binds projects case-insensitively.
 *
 * GitHub repository names are case-insensitive while `project.githubRepo` keeps
 * whatever case the binding was written in, so an exact match both missed the
 * project already on the team (a duplicate was created for the same repo) and
 * kept it out of the prune set, which then deleted the binding that was in the
 * other case.
 *
 * Prisma is mocked, matching teams-rename.test.ts: the suite pins the route
 * contract, so the `where` arguments are asserted, never evaluated. The mock
 * applies no `mode` and no lowercasing of its own; only the prune candidate
 * list it returns is simulated, and it is returned regardless of the filter the
 * route asked for. The prune deletes through the project-deletion service,
 * which is mocked here; its behaviour against a real database is pinned in
 * tests/integration/teams-sync-prune-safeguards-db.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";
import type { GitHubRepo } from "../../src/services/github-sync.js";
import { logAuditEvent } from "../../src/services/audit.js";

const prismaMocks = vi.hoisted(() => ({
  teamMemberFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
  projectFindFirst: vi.fn(),
  projectFindUnique: vi.fn(),
  projectFindMany: vi.fn(),
  projectCreate: vi.fn(),
  projectUpdate: vi.fn(),
}));
const deletionMocks = vi.hoisted(() => ({
  deleteProjectWithSafeguards: vi.fn(),
  removeStoredAttachments: vi.fn(),
}));
const githubMocks = vi.hoisted(() => ({ listUserRepos: vi.fn() }));
const boardMocks = vi.hoisted(() => ({ ensureDefaultBoardForProject: vi.fn() }));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    teamMember: { findUnique: prismaMocks.teamMemberFindUnique },
    user: { findUnique: prismaMocks.userFindUnique },
    project: {
      findFirst: prismaMocks.projectFindFirst,
      findUnique: prismaMocks.projectFindUnique,
      findMany: prismaMocks.projectFindMany,
      create: prismaMocks.projectCreate,
      update: prismaMocks.projectUpdate,
    },
  },
}));

vi.mock("../../src/services/github-sync.js", () => ({
  listUserRepos: githubMocks.listUserRepos,
}));

vi.mock("../../src/services/board-default.js", () => ({
  ensureDefaultBoardForProject: boardMocks.ensureDefaultBoardForProject,
}));

vi.mock("../../src/services/project-deletion.js", () => ({
  deleteProjectWithSafeguards: deletionMocks.deleteProjectWithSafeguards,
  removeStoredAttachments: deletionMocks.removeStoredAttachments,
}));

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import { teamRouter } from "../../src/routes/teams.js";

const TEAM_ID = "team-1";
const HUMAN: Actor = { type: "human", userId: "user-1" };
const AGENT: Actor = { type: "agent", tokenId: "tok-x", teamId: TEAM_ID, scopes: [], userId: "creator-1" };

/** GitHub's spelling of the repo; the project row below stores another case. */
const GITHUB_REPO = "LanNguyenSi/agent-tasks";
const STORED_REPO = "lannguyensi/agent-tasks";

function repo(fullName: string): GitHubRepo {
  return {
    id: 1,
    name: fullName.split("/")[1],
    full_name: fullName,
    description: null,
    archived: false,
    disabled: false,
  };
}

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", teamRouter);
  return app.request(`/teams/${TEAM_ID}/sync`, { method: "POST" });
}

type SyncBody = {
  synced: number;
  created: number;
  updated: number;
  pruned: number;
  skippedPrune: boolean;
};

async function sync(): Promise<{ status: number; body: SyncBody }> {
  const res = await makeApp(HUMAN);
  return { status: res.status, body: (await res.json()) as SyncBody };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.teamMemberFindUnique.mockResolvedValue({ teamId: TEAM_ID, userId: HUMAN.userId, role: "ADMIN" });
  prismaMocks.userFindUnique.mockResolvedValue({ id: HUMAN.userId, githubAccessToken: "gho_token" });
  // Nothing bound yet unless a test says otherwise.
  prismaMocks.projectFindFirst.mockResolvedValue(null);
  prismaMocks.projectFindUnique.mockResolvedValue(null);
  prismaMocks.projectFindMany.mockResolvedValue([]);
  prismaMocks.projectCreate.mockResolvedValue({ id: "p-new" });
  prismaMocks.projectUpdate.mockResolvedValue({ id: "p-existing" });
  // Every stale project is deleted unless a test says otherwise.
  deletionMocks.deleteProjectWithSafeguards.mockResolvedValue({ ok: true, attachmentUrls: [] });
  deletionMocks.removeStoredAttachments.mockResolvedValue(undefined);
  boardMocks.ensureDefaultBoardForProject.mockResolvedValue(undefined);
});

describe("POST /teams/:id/sync: lookup of the already-bound project", () => {
  it("looks for the exact spelling first, then matches case-insensitively with LIKE-escaping, and updates instead of creating a duplicate", async () => {
    githubMocks.listUserRepos.mockResolvedValue([repo("LanNguyenSi/agent_tasks")]);
    prismaMocks.projectFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "p-existing", githubRepo: "lannguyensi/agent_tasks" });

    const { status, body } = await sync();

    expect(status).toBe(200);
    expect(body).toMatchObject({ synced: 1, created: 0, updated: 1 });
    const orderBy = [{ createdAt: "asc" }, { id: "asc" }];
    expect(prismaMocks.projectFindFirst).toHaveBeenNthCalledWith(1, {
      where: { teamId: TEAM_ID, githubRepo: "LanNguyenSi/agent_tasks" },
      orderBy,
    });
    expect(prismaMocks.projectFindFirst).toHaveBeenNthCalledWith(2, {
      where: { teamId: TEAM_ID, githubRepo: { equals: "LanNguyenSi/agent\\_tasks", mode: "insensitive" } },
      orderBy,
    });
    expect(prismaMocks.projectCreate).not.toHaveBeenCalled();
  });

  it("prefers the exact-spelling row and never runs the insensitive lookup when it exists", async () => {
    githubMocks.listUserRepos.mockResolvedValue([repo(GITHUB_REPO)]);
    prismaMocks.projectFindFirst.mockResolvedValueOnce({ id: "p-exact", githubRepo: GITHUB_REPO });

    await sync();

    expect(prismaMocks.projectFindFirst).toHaveBeenCalledTimes(1);
    expect(prismaMocks.projectUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "p-exact" } }));
  });

  it("normalises the stored binding to GitHub's spelling on the update", async () => {
    githubMocks.listUserRepos.mockResolvedValue([repo(GITHUB_REPO)]);
    prismaMocks.projectFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "p-existing", githubRepo: STORED_REPO });

    await sync();

    expect(prismaMocks.projectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "p-existing" },
        data: expect.objectContaining({ githubRepo: GITHUB_REPO }),
      }),
    );
  });

  it("leaves githubRepo out of the update when it already has GitHub's spelling", async () => {
    githubMocks.listUserRepos.mockResolvedValue([repo(STORED_REPO)]);
    prismaMocks.projectFindFirst.mockResolvedValue({ id: "p-existing", githubRepo: STORED_REPO });

    const { body } = await sync();

    expect(body).toMatchObject({ synced: 1, created: 0, updated: 1 });
    const data = prismaMocks.projectUpdate.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("githubRepo");
    expect(data).toHaveProperty("githubSyncAt");
  });

  it("skips a repo whose write hits an active repository fence, keeps syncing the rest and reports it", async () => {
    githubMocks.listUserRepos.mockResolvedValue([repo("LanNguyenSi/fenced"), repo("LanNguyenSi/other")]);
    prismaMocks.projectFindFirst.mockResolvedValueOnce({ id: "p-fenced", githubRepo: "lannguyensi/fenced" });
    prismaMocks.projectFindFirst.mockResolvedValueOnce(null);
    prismaMocks.projectFindFirst.mockResolvedValue(null);
    prismaMocks.projectUpdate.mockRejectedValueOnce(
      Object.assign(new Error("grounding_github_fence_conflict"), { code: "P2010" }),
    );

    const { status, body } = await sync();

    expect(status).toBe(200);
    expect(body).toMatchObject({ created: 1, updated: 0, fenced: 1 });
    expect((body as unknown as { message: string }).message).toContain("sync again shortly");
  });

  it("rethrows an update error that is not a fence conflict", async () => {
    githubMocks.listUserRepos.mockResolvedValue([repo(STORED_REPO)]);
    prismaMocks.projectFindFirst.mockResolvedValue({ id: "p-existing", githubRepo: STORED_REPO });
    prismaMocks.projectUpdate.mockRejectedValueOnce(new Error("connection lost"));

    const res = await makeApp(HUMAN);

    expect(res.status).toBe(500);
  });

  it("creates a project for a repo that is bound on no project", async () => {
    githubMocks.listUserRepos.mockResolvedValue([repo(GITHUB_REPO)]);

    const { body } = await sync();

    expect(body).toMatchObject({ synced: 1, created: 1, updated: 0 });
    expect(prismaMocks.projectCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ githubRepo: GITHUB_REPO }) }),
    );
  });

  it("403s an agent actor before GitHub or Prisma are touched", async () => {
    const res = await makeApp(AGENT);
    expect(res.status).toBe(403);
    expect(githubMocks.listUserRepos).not.toHaveBeenCalled();
    expect(prismaMocks.projectFindFirst).not.toHaveBeenCalled();
  });
});

/** The project ids the prune handed to the deletion service, in order. */
function deletedIds(): string[] {
  return deletionMocks.deleteProjectWithSafeguards.mock.calls.map((call) => call[1] as string);
}

describe("POST /teams/:id/sync: prune", () => {
  it("never prunes a binding whose case differs from GitHub's spelling", async () => {
    githubMocks.listUserRepos.mockResolvedValue([repo(GITHUB_REPO)]);
    prismaMocks.projectFindFirst.mockResolvedValue({ id: "p-existing", githubRepo: STORED_REPO });
    prismaMocks.projectFindMany.mockResolvedValue([{ id: "p-existing", githubRepo: STORED_REPO }]);

    const { body } = await sync();

    expect(body).toMatchObject({ updated: 1, pruned: 0, skippedPrune: false });
    expect(deletionMocks.deleteProjectWithSafeguards).not.toHaveBeenCalled();
  });

  it("reads the prune candidates from the team only, githubRepo-bound only, and compares lowercased", async () => {
    githubMocks.listUserRepos.mockResolvedValue([repo(GITHUB_REPO)]);
    prismaMocks.projectFindFirst.mockResolvedValue({ id: "p-existing", githubRepo: STORED_REPO });
    prismaMocks.projectFindMany.mockResolvedValue([
      { id: "p-existing", githubRepo: STORED_REPO },
      { id: "p-other-case", githubRepo: "LanNguyenSi/Agent-Tasks" },
    ]);

    const { body } = await sync();

    expect(prismaMocks.projectFindMany).toHaveBeenCalledWith({
      where: { teamId: TEAM_ID, githubRepo: { not: null } },
      select: { id: true, githubRepo: true },
    });
    // Both rows are the listed repo, whatever their case: nothing is deleted.
    expect(body.pruned).toBe(0);
    expect(deletionMocks.deleteProjectWithSafeguards).not.toHaveBeenCalled();
  });

  it("prunes a project bound to a repo that is no longer listed, and keeps every case of the listed ones", async () => {
    githubMocks.listUserRepos.mockResolvedValue([repo(GITHUB_REPO)]);
    prismaMocks.projectFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "p-existing", githubRepo: STORED_REPO });
    prismaMocks.projectFindMany.mockResolvedValue([
      { id: "p-existing", githubRepo: STORED_REPO },
      { id: "p-gone-lower", githubRepo: "lannguyensi/retired" },
      { id: "p-gone-mixed", githubRepo: "LanNguyenSi/Retired-Twice" },
    ]);

    const { body } = await sync();

    expect(body).toMatchObject({ pruned: 2, skippedPrune: false });
    expect(deletedIds()).toEqual(["p-gone-lower", "p-gone-mixed"]);
  });

  it("prunes a project whose binding has a different owner case only when it is another repo", async () => {
    githubMocks.listUserRepos.mockResolvedValue([repo("LanNguyenSi/agent-tasks")]);
    prismaMocks.projectFindFirst.mockResolvedValue(null);
    prismaMocks.projectFindMany.mockResolvedValue([{ id: "p-other-repo", githubRepo: "LanNguyenSi/agent-tasks-other" }]);

    const { body } = await sync();

    // A prefix match is not a match: the repo names differ beyond case.
    expect(body.pruned).toBe(1);
    expect(deletedIds()).toEqual(["p-other-repo"]);
  });

  it("skips the prune entirely when GitHub lists no repo, and never loads the candidate rows", async () => {
    githubMocks.listUserRepos.mockResolvedValue([]);

    const { body } = await sync();

    expect(body).toMatchObject({ synced: 0, created: 0, updated: 0, pruned: 0, skippedPrune: true });
    expect(prismaMocks.projectFindMany).not.toHaveBeenCalled();
    expect(deletionMocks.deleteProjectWithSafeguards).not.toHaveBeenCalled();
  });
});

describe("POST /teams/:id/sync: prune is for team admins only", () => {
  const STALE_ROWS = [
    { id: "p-keep", githubRepo: STORED_REPO },
    { id: "p-gone", githubRepo: "lannguyensi/retired" },
  ];

  for (const role of ["HUMAN_MEMBER", "REVIEWER"]) {
    it(`${role} never loads the prune candidates, never deletes, and is told why`, async () => {
      prismaMocks.teamMemberFindUnique.mockResolvedValue({ teamId: TEAM_ID, userId: HUMAN.userId, role });
      githubMocks.listUserRepos.mockResolvedValue([repo(GITHUB_REPO)]);
      prismaMocks.projectFindFirst.mockResolvedValue({ id: "p-keep", githubRepo: STORED_REPO });
      prismaMocks.projectFindMany.mockResolvedValue(STALE_ROWS);

      const res = await makeApp(HUMAN);
      const body = (await res.json()) as Record<string, unknown>;

      expect(res.status).toBe(200);
      expect(body).toMatchObject({ updated: 1, pruned: 0, pruneDeferred: false, skippedPrune: false, pruneSkipped: "not_admin" });
      expect(String(body.message)).toContain("Stale projects are only removed by a team admin.");
      expect(prismaMocks.projectUpdate).toHaveBeenCalledTimes(1);
      expect(prismaMocks.projectFindMany).not.toHaveBeenCalled();
      expect(deletionMocks.deleteProjectWithSafeguards).not.toHaveBeenCalled();
      expect(vi.mocked(logAuditEvent)).not.toHaveBeenCalled();
    });
  }

  it("a non-admin with an empty list: skippedPrune and pruneSkipped are both set, the empty-list sentence comes first", async () => {
    prismaMocks.teamMemberFindUnique.mockResolvedValue({ teamId: TEAM_ID, userId: HUMAN.userId, role: "HUMAN_MEMBER" });
    githubMocks.listUserRepos.mockResolvedValue([]);

    const res = await makeApp(HUMAN);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ pruned: 0, skippedPrune: true, pruneSkipped: "not_admin", pruneDeferred: false });
    expect(body.message).toBe(
      "GitHub sync returned 0 repositories; prune was skipped for safety. Stale projects are only removed by a team admin.",
    );
  });

  it("an admin prunes as before, reports pruneSkipped null and audits the deleted ids with team and actor", async () => {
    githubMocks.listUserRepos.mockResolvedValue([repo(GITHUB_REPO)]);
    prismaMocks.projectFindFirst.mockResolvedValue({ id: "p-keep", githubRepo: STORED_REPO });
    prismaMocks.projectFindMany.mockResolvedValue(STALE_ROWS);

    const res = await makeApp(HUMAN);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ pruned: 1, pruneSkipped: null, skippedPrune: false });
    expect(String(body.message)).not.toContain("team admin");
    expect(deletedIds()).toEqual(["p-gone"]);
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith({
      action: "project.synced",
      actorId: HUMAN.userId,
      payload: {
        teamId: TEAM_ID,
        via: "team_sync_prune",
        candidateProjectIds: ["p-gone"],
        deletedProjectIds: ["p-gone"],
        deletedCount: 1,
        skippedProjects: [],
      },
    });
  });

  it("an admin with no stale project emits no audit event", async () => {
    githubMocks.listUserRepos.mockResolvedValue([repo(GITHUB_REPO)]);
    prismaMocks.projectFindFirst.mockResolvedValue({ id: "p-keep", githubRepo: STORED_REPO });
    prismaMocks.projectFindMany.mockResolvedValue([{ id: "p-keep", githubRepo: STORED_REPO }]);

    await makeApp(HUMAN);

    expect(vi.mocked(logAuditEvent)).not.toHaveBeenCalled();
  });

  it("an admin whose prune deletes fewer projects than it picked reports the deleted count and lists every candidate id", async () => {
    githubMocks.listUserRepos.mockResolvedValue([repo(GITHUB_REPO)]);
    prismaMocks.projectFindFirst.mockResolvedValue({ id: "p-keep", githubRepo: STORED_REPO });
    prismaMocks.projectFindMany.mockResolvedValue([
      { id: "p-keep", githubRepo: STORED_REPO },
      { id: "p-gone-a", githubRepo: "lannguyensi/retired-a" },
      { id: "p-gone-b", githubRepo: "lannguyensi/retired-b" },
    ]);
    deletionMocks.deleteProjectWithSafeguards
      .mockResolvedValueOnce({ ok: true, attachmentUrls: [] })
      .mockResolvedValueOnce({ ok: false, reason: "not_eligible" });

    const res = await makeApp(HUMAN);

    expect(((await res.json()) as { pruned: number }).pruned).toBe(1);
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith({
      action: "project.synced",
      actorId: HUMAN.userId,
      payload: {
        teamId: TEAM_ID,
        via: "team_sync_prune",
        candidateProjectIds: ["p-gone-a", "p-gone-b"],
        deletedProjectIds: ["p-gone-a"],
        deletedCount: 1,
        skippedProjects: [],
      },
    });
  });

  it("an admin whose every stale project is refused as not eligible emits no audit event", async () => {
    githubMocks.listUserRepos.mockResolvedValue([repo(GITHUB_REPO)]);
    prismaMocks.projectFindFirst.mockResolvedValue({ id: "p-keep", githubRepo: STORED_REPO });
    prismaMocks.projectFindMany.mockResolvedValue(STALE_ROWS);
    deletionMocks.deleteProjectWithSafeguards.mockResolvedValue({ ok: false, reason: "not_eligible" });

    const res = await makeApp(HUMAN);

    expect(((await res.json()) as { pruned: number }).pruned).toBe(0);
    expect(vi.mocked(logAuditEvent)).not.toHaveBeenCalled();
  });
});

describe("POST /teams/:id/sync: prune through the deletion service", () => {
  const STALE = [
    { id: "p-keep", githubRepo: STORED_REPO },
    { id: "p-gone", githubRepo: "lannguyensi/retired" },
  ];
  function arrange() {
    githubMocks.listUserRepos.mockResolvedValue([repo(GITHUB_REPO)]);
    prismaMocks.projectFindFirst.mockResolvedValue({ id: "p-keep", githubRepo: STORED_REPO });
    prismaMocks.projectFindMany.mockResolvedValue(STALE);
  }
  type Admit = (db: unknown, project: { teamId: string; githubRepo: string | null }) => Promise<boolean>;
  function admitHook(): Admit {
    const options = deletionMocks.deleteProjectWithSafeguards.mock.calls[0]![2] as { admit: Admit };
    return options.admit;
  }

  it("the admit hook accepts a project of this team whose repo is still not listed, in any case", async () => {
    arrange();
    await sync();
    const admit = admitHook();

    expect(await admit({}, { teamId: TEAM_ID, githubRepo: "lannguyensi/retired" })).toBe(true);
    expect(await admit({}, { teamId: TEAM_ID, githubRepo: "LanNguyenSi/RETIRED" })).toBe(true);
  });

  it("the admit hook refuses a project that moved to another team", async () => {
    arrange();
    await sync();

    expect(await admitHook()({}, { teamId: "team-2", githubRepo: "lannguyensi/retired" })).toBe(false);
  });

  it("the admit hook refuses a project that was unbound or rebound to a listed repo, whatever the case", async () => {
    arrange();
    await sync();
    const admit = admitHook();

    expect(await admit({}, { teamId: TEAM_ID, githubRepo: null })).toBe(false);
    expect(await admit({}, { teamId: TEAM_ID, githubRepo: GITHUB_REPO })).toBe(false);
    expect(await admit({}, { teamId: TEAM_ID, githubRepo: STORED_REPO })).toBe(false);
  });

  it("reclaims the attachment files of a deleted project and only of those", async () => {
    arrange();
    prismaMocks.projectFindMany.mockResolvedValue([
      ...STALE,
      { id: "p-kept-history", githubRepo: "lannguyensi/retired-2" },
    ]);
    deletionMocks.deleteProjectWithSafeguards
      .mockResolvedValueOnce({ ok: true, attachmentUrls: ["/uploads/a.txt"] })
      .mockResolvedValueOnce({ ok: false, reason: "retained" });

    await sync();

    expect(deletionMocks.removeStoredAttachments).toHaveBeenCalledTimes(1);
    expect(deletionMocks.removeStoredAttachments).toHaveBeenCalledWith(["/uploads/a.txt"]);
  });

  it("reports a retained and a reservation-pending project with their reasons, in the response, the message and the audit event", async () => {
    arrange();
    prismaMocks.projectFindMany.mockResolvedValue([
      { id: "p-ret", githubRepo: "lannguyensi/retired-ret" },
      { id: "p-pend", githubRepo: "lannguyensi/retired-pend" },
      { id: "p-del", githubRepo: "lannguyensi/retired-del" },
    ]);
    deletionMocks.deleteProjectWithSafeguards
      .mockResolvedValueOnce({ ok: false, reason: "retained" })
      .mockResolvedValueOnce({ ok: false, reason: "reservation_pending" })
      .mockResolvedValueOnce({ ok: true, attachmentUrls: [] });

    const res = await makeApp(HUMAN);
    const body = (await res.json()) as Record<string, unknown>;

    const skipped = [
      { projectId: "p-ret", reason: "grounding_history_retained" },
      { projectId: "p-pend", reason: "grounding_finalization_pending" },
    ];
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ pruned: 1, pruneDeferred: false, pruneRetained: skipped });
    expect(String(body.message)).toContain("2 stale projects were kept");
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith({
      action: "project.synced",
      actorId: HUMAN.userId,
      payload: {
        teamId: TEAM_ID,
        via: "team_sync_prune",
        candidateProjectIds: ["p-ret", "p-pend", "p-del"],
        deletedProjectIds: ["p-del"],
        deletedCount: 1,
        skippedProjects: skipped,
      },
    });
  });

  it("uses the singular in the message for one kept project and audits a prune that kept everything", async () => {
    arrange();
    deletionMocks.deleteProjectWithSafeguards.mockResolvedValue({ ok: false, reason: "retained" });

    const body = (await (await makeApp(HUMAN)).json()) as Record<string, unknown>;

    expect(body).toMatchObject({ pruned: 0, pruneRetained: [{ projectId: "p-gone", reason: "grounding_history_retained" }] });
    expect(String(body.message)).toContain("1 stale project was kept");
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledTimes(1);
  });

  it("answers an empty pruneRetained and no kept-project sentence when nothing was kept", async () => {
    arrange();

    const body = (await (await makeApp(HUMAN)).json()) as Record<string, unknown>;

    expect(body.pruneRetained).toEqual([]);
    expect(String(body.message)).not.toContain("kept because");
  });

  it("a fenced project sets pruneDeferred, the others still go, and a fence alone writes no audit event", async () => {
    arrange();
    prismaMocks.projectFindMany.mockResolvedValue([
      { id: "p-fenced", githubRepo: "lannguyensi/retired-f" },
      { id: "p-free", githubRepo: "lannguyensi/retired-g" },
    ]);
    deletionMocks.deleteProjectWithSafeguards
      .mockResolvedValueOnce({ ok: false, reason: "fenced" })
      .mockResolvedValueOnce({ ok: true, attachmentUrls: [] });

    const body = (await (await makeApp(HUMAN)).json()) as Record<string, unknown>;

    expect(body).toMatchObject({ pruned: 1, pruneDeferred: true, pruneRetained: [] });
    expect(String(body.message)).toContain("postponed");

    deletionMocks.deleteProjectWithSafeguards.mockReset();
    deletionMocks.deleteProjectWithSafeguards.mockResolvedValue({ ok: false, reason: "fenced" });
    vi.mocked(logAuditEvent).mockClear();
    const alone = (await (await makeApp(HUMAN)).json()) as Record<string, unknown>;
    expect(alone).toMatchObject({ pruned: 0, pruneDeferred: true });
    expect(vi.mocked(logAuditEvent)).not.toHaveBeenCalled();
  });

  it("a deletion error that is not a refusal fails the request, and the projects already deleted are still audited", async () => {
    arrange();
    prismaMocks.projectFindMany.mockResolvedValue([
      { id: "p-first", githubRepo: "lannguyensi/retired-1" },
      { id: "p-second", githubRepo: "lannguyensi/retired-2" },
    ]);
    deletionMocks.deleteProjectWithSafeguards
      .mockResolvedValueOnce({ ok: true, attachmentUrls: [] })
      .mockRejectedValueOnce(new Error("connection lost"));

    const res = await makeApp(HUMAN);

    expect(res.status).toBe(500);
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ deletedProjectIds: ["p-first"], deletedCount: 1 }),
      }),
    );
  });
});
