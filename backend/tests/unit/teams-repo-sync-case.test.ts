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
 * route asked for.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";
import type { GitHubRepo } from "../../src/services/github-sync.js";

const prismaMocks = vi.hoisted(() => ({
  teamMemberFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
  projectFindFirst: vi.fn(),
  projectFindUnique: vi.fn(),
  projectFindMany: vi.fn(),
  projectCreate: vi.fn(),
  projectUpdate: vi.fn(),
  projectDeleteMany: vi.fn(),
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
      deleteMany: prismaMocks.projectDeleteMany,
    },
  },
}));

vi.mock("../../src/services/github-sync.js", () => ({
  listUserRepos: githubMocks.listUserRepos,
}));

vi.mock("../../src/services/board-default.js", () => ({
  ensureDefaultBoardForProject: boardMocks.ensureDefaultBoardForProject,
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
  // Never evaluates the filter: it only reports how many ids it was handed.
  prismaMocks.projectDeleteMany.mockImplementation(({ where }: { where: { id?: { in?: string[] } } }) =>
    Promise.resolve({ count: where.id?.in?.length ?? 1 }),
  );
  boardMocks.ensureDefaultBoardForProject.mockResolvedValue(undefined);
});

describe("POST /teams/:id/sync: lookup of the already-bound project", () => {
  it("matches githubRepo case-insensitively and updates the project instead of creating a duplicate", async () => {
    githubMocks.listUserRepos.mockResolvedValue([repo(GITHUB_REPO)]);
    prismaMocks.projectFindFirst.mockResolvedValue({ id: "p-existing", githubRepo: STORED_REPO });

    const { status, body } = await sync();

    expect(status).toBe(200);
    expect(body).toMatchObject({ synced: 1, created: 0, updated: 1 });
    expect(prismaMocks.projectFindFirst).toHaveBeenCalledWith({
      where: { teamId: TEAM_ID, githubRepo: { equals: GITHUB_REPO, mode: "insensitive" } },
    });
    expect(prismaMocks.projectCreate).not.toHaveBeenCalled();
  });

  it("normalises the stored binding to GitHub's spelling on the update", async () => {
    githubMocks.listUserRepos.mockResolvedValue([repo(GITHUB_REPO)]);
    prismaMocks.projectFindFirst.mockResolvedValue({ id: "p-existing", githubRepo: STORED_REPO });

    await sync();

    expect(prismaMocks.projectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "p-existing" },
        data: expect.objectContaining({ githubRepo: GITHUB_REPO }),
      }),
    );
  });

  it("still updates an exactly-matching binding, and writes the same spelling back", async () => {
    githubMocks.listUserRepos.mockResolvedValue([repo(STORED_REPO)]);
    prismaMocks.projectFindFirst.mockResolvedValue({ id: "p-existing", githubRepo: STORED_REPO });

    const { body } = await sync();

    expect(body).toMatchObject({ synced: 1, created: 0, updated: 1 });
    expect(prismaMocks.projectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ githubRepo: STORED_REPO }) }),
    );
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

describe("POST /teams/:id/sync: prune", () => {
  it("never prunes a binding whose case differs from GitHub's spelling", async () => {
    githubMocks.listUserRepos.mockResolvedValue([repo(GITHUB_REPO)]);
    prismaMocks.projectFindFirst.mockResolvedValue({ id: "p-existing", githubRepo: STORED_REPO });
    prismaMocks.projectFindMany.mockResolvedValue([{ id: "p-existing", githubRepo: STORED_REPO }]);

    const { body } = await sync();

    expect(body).toMatchObject({ updated: 1, pruned: 0, skippedPrune: false });
    expect(prismaMocks.projectDeleteMany).not.toHaveBeenCalled();
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
    expect(prismaMocks.projectDeleteMany).not.toHaveBeenCalled();
  });

  it("prunes a project bound to a repo that is no longer listed, and keeps every case of the listed ones", async () => {
    githubMocks.listUserRepos.mockResolvedValue([repo(GITHUB_REPO)]);
    prismaMocks.projectFindFirst.mockResolvedValue({ id: "p-existing", githubRepo: STORED_REPO });
    prismaMocks.projectFindMany.mockResolvedValue([
      { id: "p-existing", githubRepo: STORED_REPO },
      { id: "p-gone-lower", githubRepo: "lannguyensi/retired" },
      { id: "p-gone-mixed", githubRepo: "LanNguyenSi/Retired-Twice" },
    ]);

    const { body } = await sync();

    expect(body).toMatchObject({ pruned: 2, skippedPrune: false });
    expect(prismaMocks.projectDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["p-gone-lower", "p-gone-mixed"] } },
    });
  });

  it("prunes a project whose binding has a different owner case only when it is another repo", async () => {
    githubMocks.listUserRepos.mockResolvedValue([repo("LanNguyenSi/agent-tasks")]);
    prismaMocks.projectFindFirst.mockResolvedValue(null);
    prismaMocks.projectFindMany.mockResolvedValue([{ id: "p-other-repo", githubRepo: "LanNguyenSi/agent-tasks-other" }]);

    const { body } = await sync();

    // A prefix match is not a match: the repo names differ beyond case.
    expect(body.pruned).toBe(1);
    expect(prismaMocks.projectDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["p-other-repo"] } },
    });
  });

  it("skips the prune entirely when GitHub lists no repo, and never loads the candidate rows", async () => {
    githubMocks.listUserRepos.mockResolvedValue([]);

    const { body } = await sync();

    expect(body).toMatchObject({ synced: 0, created: 0, updated: 0, pruned: 0, skippedPrune: true });
    expect(prismaMocks.projectFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.projectDeleteMany).not.toHaveBeenCalled();
  });
});
