import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { groundingPostgres, barrier } from "../helpers/grounding-postgres.js";
import { acquireGithubFence, assertGithubFenceOwned, canonicalGithubRepo, releaseGithubFence, withGithubFenceWrites, type GithubFenceOwner } from "../../src/services/grounding-github-fence.js";

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let f: Awaited<ReturnType<typeof fixture>>;
const teamId = randomUUID();
beforeAll(async () => { store = await groundingPostgres(); await store.db.team.create({ data: { id: teamId, name: "Fence", slug: teamId } }); }, 60000);
afterAll(async () => { if (store) await store.close(); });
beforeEach(async () => { f = await fixture(); });
async function fixture() {
  const repo = `acme/${randomUUID()}`;
  const project = await store.db.project.create({ data: { teamId, name: "Fence", slug: randomUUID(), githubRepo: repo } });
  const other = await store.db.project.create({ data: { teamId, name: "Other", slug: randomUUID(), githubRepo: `other/${randomUUID()}` } });
  const task = await store.db.task.create({ data: { projectId: project.id, title: "Original", prNumber: 42, prUrl: `https://github.com/${repo}/pull/42`, branchName: "work" } });
  const foreign = await store.db.task.create({ data: { projectId: other.id, title: "Foreign" } });
  const owner: GithubFenceOwner = { id: randomUUID(), repo, kind: "MERGE", taskId: task.id };
  return { repo, project, other, task, foreign, owner };
}
const reserve = () => store.db.$transaction(tx => acquireGithubFence(tx, f.owner));
const blocked = async (write: Promise<unknown>) => { await expect(write).rejects.toThrow(/grounding_github_fence_conflict/); };
const enrollment = () => ({ taskId: f.task.id, projectId: f.project.id, mode: "OFF" as const, protected: false, provenance: "test" });
const binding = () => ({ taskId: f.task.id, projectId: f.project.id, audience: "test", subjectMode: "CODE_HEAD" as const, policyId: "test", policyRevision: "1", policySha256: "a".repeat(64) });
async function legacy(tx: Prisma.TransactionClient, taskId = f.task.id) {
  const operation = await tx.groundingOperation.create({ data: { taskId, key: randomUUID(), actorType: "human", actorId: "test", fingerprint: "test", request: {}, decision: {}, state: "RESERVED", repo: f.repo, prNumber: 42 } });
  await tx.groundingCohort.upsert({ where: { taskId }, create: { ...enrollment(), taskId, reservationId: operation.id }, update: { reservationId: operation.id } });
  return operation;
}

it("canonical case identities share one durable row; SQL and adapter agree", async () => {
  const values = [f.repo, f.repo.toUpperCase(), ` ${f.repo} `, `\t${f.repo}\r\n`, `\uFEFF${f.repo}\u00A0`];
  for (const invalid of ["./repo", "acme/..", "acme/repo/extra"]) {
    expect(() => canonicalGithubRepo(invalid)).toThrow();
    const [row] = await store.db.$queryRaw<{ repo: string | null }[]>`SELECT grounding_github_repo(${invalid}) AS repo`;
    expect(row.repo).toBeNull();
  }
  for (const value of values) {
    const [row] = await store.db.$queryRaw<{ repo: string }[]>`SELECT grounding_github_repo(${value}) AS repo`;
    expect(row.repo).toBe(canonicalGithubRepo(value));
  }
  await store.db.$transaction(tx => acquireGithubFence(tx, { ...f.owner, repo: f.repo.toUpperCase() }));
  await blocked(store.db.task.update({ where: { id: f.foreign.id }, data: { deliverableRepo: `\t${f.repo.toUpperCase()}\n` } }));
  expect(await store.db.groundingGithubRepositoryFence.count({ where: { repo: { equals: f.repo, mode: "insensitive" } } })).toBe(1);
  expect(() => canonicalGithubRepo("https://github.com/a/b")).toThrow();
});

it("raw INSERT, DELETE and old/new task identities cannot evade a cross-project fence", async () => {
  await reserve();
  await blocked(store.db.task.create({ data: { projectId: f.other.id, title: "Join", deliverableRepo: f.repo } }));
  await blocked(store.db.task.create({ data: { projectId: f.other.id, title: "URL join", prUrl: `https://GitHub.com/${f.repo.toUpperCase()}/pull/17` } }));
  await blocked(store.db.task.create({ data: { projectId: f.other.id, title: "Malformed PR join", prUrl: `https://github.com/${f.repo}/pull/not-a-number` } }));
  await blocked(store.db.task.delete({ where: { id: f.task.id } }));
  await blocked(store.db.task.update({ where: { id: f.foreign.id }, data: { projectId: f.project.id } }));
  await blocked(store.db.task.update({ where: { id: f.task.id }, data: { projectId: f.other.id, deliverableRepo: f.other.githubRepo, prUrl: null } }));
  for (const data of [{ deliverableRepo: f.repo }, { prUrl: `https://github.com/${f.repo}/pull/22` }]) await blocked(store.db.task.update({ where: { id: f.foreign.id }, data }));
});

it("raw task status, claims, context and PR fields are fenced; identical writes are no-ops", async () => {
  await reserve();
  for (const data of [{ title: "Changed" }, { description: "Changed" }, { templateData: { goal: "Changed" } }, { status: "done" }, { claimedAt: new Date() }, { branchName: "other" }, { prNumber: 43 }, { prUrl: null }, { deliverableRepo: f.other.githubRepo }, { labels: ["x"] }]) await blocked(store.db.task.update({ where: { id: f.task.id }, data }));
  const before = await store.db.groundingGithubRepositoryFence.findUniqueOrThrow({ where: { repo: f.repo } });
  await store.db.task.update({ where: { id: f.task.id }, data: { title: f.task.title, prNumber: 42 } });
  await store.db.project.update({ where: { id: f.project.id }, data: { githubRepo: f.repo, name: "Display only" } });
  const after = await store.db.groundingGithubRepositoryFence.findUniqueOrThrow({ where: { repo: f.repo } });
  expect(after.version).toBe(before.version);
});

it("project old/new repos and foreign deliverable repos are fenced", async () => {
  await store.db.task.update({ where: { id: f.foreign.id }, data: { deliverableRepo: f.repo } });
  await reserve();
  await blocked(store.db.project.update({ where: { id: f.other.id }, data: { githubRepo: `third/${randomUUID()}` } }));
  await blocked(store.db.project.update({ where: { id: f.project.id }, data: { githubRepo: null } }));
  await blocked(store.db.project.delete({ where: { id: f.project.id } }));
  const fresh = await store.db.project.create({ data: { teamId, slug: randomUUID(), name: "Fresh" } });
  await blocked(store.db.project.update({ where: { id: fresh.id }, data: { githubRepo: f.repo.toUpperCase() } }));
});

it.each(["cohort", "binding"] as const)("raw %s enrollment INSERT/UPDATE/DELETE and reassignment cannot bypass", async kind => {
  if (kind === "cohort") await store.db.groundingCohort.create({ data: enrollment() });
  else await store.db.groundingBinding.create({ data: binding() });
  await reserve();
  if (kind === "cohort") {
    await blocked(store.db.groundingCohort.update({ where: { taskId: f.task.id }, data: { protected: true } }));
    await blocked(store.db.groundingCohort.delete({ where: { taskId: f.task.id } }));
    await blocked(store.db.groundingCohort.update({ where: { taskId: f.task.id }, data: { taskId: f.foreign.id, projectId: f.other.id } }));
    await store.db.groundingCohort.update({ where: { taskId: f.task.id }, data: { protected: false } });
  } else {
    await blocked(store.db.groundingBinding.update({ where: { taskId: f.task.id }, data: { contextRevision: 2 } }));
    await blocked(store.db.groundingBinding.delete({ where: { taskId: f.task.id } }));
    await blocked(store.db.groundingBinding.update({ where: { taskId: f.task.id }, data: { taskId: f.foreign.id, projectId: f.other.id } }));
    await store.db.groundingBinding.update({ where: { taskId: f.task.id }, data: { protected: true } });
  }
  const peer = await store.db.$transaction(tx => withGithubFenceWrites(tx, f.owner, "peer", async tx => tx.task.create({ data: { id: "peer", projectId: f.project.id, title: "Peer" } })));
  if (kind === "cohort") await blocked(store.db.groundingCohort.create({ data: { ...enrollment(), taskId: peer.id } }));
  else await blocked(store.db.groundingBinding.create({ data: { ...binding(), taskId: peer.id } }));
  await store.db.$transaction(tx => withGithubFenceWrites(tx, f.owner, peer.id, tx => tx.task.delete({ where: { id: peer.id } })));
});

it("exact owner, repo, kind and task scope; release is idempotent and stale IDs stay closed", async () => {
  await reserve(); await reserve();
  for (const owner of [{ ...f.owner, id: randomUUID() }, { ...f.owner, repo: f.other.githubRepo! }, { ...f.owner, kind: "PR_CREATE" as const }, { ...f.owner, taskId: f.foreign.id }]) {
    await expect(store.db.$transaction(tx => assertGithubFenceOwned(tx, owner))).rejects.toThrow();
    await expect(store.db.$transaction(tx => releaseGithubFence(tx, owner))).rejects.toThrow();
  }
  await store.db.$transaction(tx => withGithubFenceWrites(tx, f.owner, f.task.id, tx => tx.task.update({ where: { id: f.task.id }, data: { title: "Owned" } })));
  await blocked(store.db.$transaction(tx => withGithubFenceWrites(tx, f.owner, f.foreign.id, tx => tx.task.update({ where: { id: f.task.id }, data: { title: "Wrong task" } }))));
  await blocked(store.db.$transaction(tx => withGithubFenceWrites(tx, f.owner, f.task.id, tx => tx.project.update({ where: { id: f.project.id }, data: { githubRepo: null } }))));
  await store.db.$transaction(tx => releaseGithubFence(tx, f.owner));
  await store.db.$transaction(tx => releaseGithubFence(tx, f.owner));
  await expect(reserve()).rejects.toThrow(/Released intent/);
  await store.db.task.update({ where: { id: f.task.id }, data: { title: "After release" } });
  const next = { ...f.owner, id: randomUUID() };
  await store.db.$transaction(tx => acquireGithubFence(tx, next));
  await store.db.$transaction(tx => releaseGithubFence(tx, f.owner));
  expect((await store.db.groundingGithubRepositoryFence.findUniqueOrThrow({ where: { repo: f.repo } })).ownerId).toBe(next.id);
});

it("owner settings reset after callback, commit and rollback on the same pooled connection", async () => {
  await reserve();
  const one = store.connect(1);
  await one.$transaction(async tx => {
    await withGithubFenceWrites(tx, f.owner, f.task.id, tx => tx.task.update({ where: { id: f.task.id }, data: { title: "Inside" } }));
    const [setting] = await tx.$queryRaw<{ owner: string }[]>`SELECT current_setting('grounding.github_owner', true) AS owner`;
    expect(setting.owner).toBe("");
  });
  await blocked(one.task.update({ where: { id: f.task.id }, data: { title: "Leaked commit" } }));
  await expect(one.$transaction(tx => withGithubFenceWrites(tx, f.owner, f.task.id, async tx => { await tx.task.update({ where: { id: f.task.id }, data: { title: "Rollback" } }); throw new Error("rollback"); }))).rejects.toThrow("rollback");
  await blocked(one.task.update({ where: { id: f.task.id }, data: { title: "Leaked rollback" } }));
  for (const [id, repo] of [[randomUUID(), f.repo], [f.owner.id, f.other.githubRepo!]]) await blocked(one.$transaction(async tx => {
    await tx.$queryRaw`SELECT set_config('grounding.github_owner', ${id}, true), set_config('grounding.github_repo', ${repo}, true), set_config('grounding.github_task', ${f.task.id}, true)`;
    return tx.task.update({ where: { id: f.task.id }, data: { title: "Forged" } });
  }));
});

it("PR_CREATE owns only its task even before the PR number is known", async () => {
  const owner: GithubFenceOwner = { ...f.owner, kind: "PR_CREATE", taskId: f.foreign.id, repo: f.other.githubRepo! };
  const peer = await store.db.task.create({ data: { projectId: f.other.id, title: "Peer" } });
  await store.db.$transaction(tx => acquireGithubFence(tx, owner));
  await blocked(store.db.$transaction(async tx => {
    await tx.$queryRaw`SELECT set_config('grounding.github_owner', ${owner.id}, true), set_config('grounding.github_repo', ${owner.repo}, true), set_config('grounding.github_task', ${peer.id}, true)`;
    return tx.task.update({ where: { id: peer.id }, data: { title: "Wrong intent task" } });
  }));
  await store.db.$transaction(tx => withGithubFenceWrites(tx, owner, f.foreign.id, tx => tx.task.update({ where: { id: f.foreign.id }, data: { prNumber: 9, prUrl: `https://github.com/${owner.repo}/pull/9`, branchName: "created" } })));
  await expect(store.db.$transaction(tx => withGithubFenceWrites(tx, owner, f.task.id, async () => {}))).rejects.toThrow(/Invalid operation task/);
});

it("legacy task reservations block acquisition and active fence blocks later legacy reservation", async () => {
  await store.db.$transaction(tx => legacy(tx));
  await expect(reserve()).rejects.toThrow(/Existing task reservation/);
  f = await fixture(); await reserve();
  await blocked(store.db.$transaction(tx => legacy(tx)));
  expect(await store.db.groundingOperation.count({ where: { taskId: f.task.id } })).toBe(0);
});

it.each([Prisma.TransactionIsolationLevel.ReadCommitted, Prisma.TransactionIsolationLevel.Serializable])("%s writer snapshot before fence commit cannot write after acquisition", async isolationLevel => {
  const gate = barrier(); const writer = store.connect();
  const pending = writer.$transaction(async tx => {
    await tx.task.findUniqueOrThrow({ where: { id: f.task.id } });
    await gate.wait();
    return tx.task.update({ where: { id: f.task.id }, data: { title: "Racing" } });
  }, { isolationLevel, timeout: 15000 }).then(() => "committed", e => String(e));
  await gate.reached; await reserve(); gate.release();
  expect(await pending).toMatch(/grounding_github_fence_conflict|write conflict|40001|serialize/i);
  expect((await store.db.task.findUniqueOrThrow({ where: { id: f.task.id } })).title).toBe("Original");
});

it.each([Prisma.TransactionIsolationLevel.ReadCommitted, Prisma.TransactionIsolationLevel.Serializable])("%s reserve snapshot before legacy writer commit serializes or rejects", async isolationLevel => {
  const gate = barrier(); const reserver = store.connect();
  const pending = reserver.$transaction(async tx => {
    await tx.task.findMany({ where: { projectId: f.project.id } });
    await gate.wait();
    return acquireGithubFence(tx, f.owner);
  }, { isolationLevel, timeout: 15000 }).then(() => "committed", e => String(e));
  await gate.reached; await store.db.$transaction(tx => legacy(tx)); gate.release();
  expect(await pending).toMatch(/Existing task reservation|write conflict|40001|serialize/i);
  expect((await store.db.groundingGithubRepositoryFence.findUniqueOrThrow({ where: { repo: f.repo } })).ownerId).toBeNull();
});

it.each([Prisma.TransactionIsolationLevel.ReadCommitted, Prisma.TransactionIsolationLevel.Serializable])("%s waiting reserve sees committed membership or rolls back", async isolationLevel => {
  const gate = barrier(); const writer = store.connect();
  const writing = writer.$transaction(async tx => { await tx.task.update({ where: { id: f.foreign.id }, data: { deliverableRepo: f.repo } }); await gate.wait(); }, { timeout: 15000 });
  await gate.reached;
  const started = barrier();
  const pending = store.db.$transaction(async tx => { await tx.task.findMany(); await started.wait(); await acquireGithubFence(tx, f.owner); return tx.task.findMany({ where: { deliverableRepo: f.repo } }); }, { isolationLevel, timeout: 15000 }).then(rows => rows, e => String(e));
  await started.reached; started.release(); gate.release(); await writing;
  const result = await pending;
  if (isolationLevel === "ReadCommitted") expect(result).toEqual([expect.objectContaining({ id: f.foreign.id })]);
  else expect(result).toMatch(/write conflict|40001|serialize/i);
});

it("missing/disabled SQL fails acquisition closed", async () => {
  await store.db.$executeRawUnsafe('ALTER TABLE tasks DISABLE TRIGGER grounding_github_task_fence');
  try { await expect(reserve()).rejects.toThrow(/not installed/); }
  finally { await store.db.$executeRawUnsafe('ALTER TABLE tasks ENABLE TRIGGER grounding_github_task_fence'); }
  await store.db.$executeRawUnsafe('DROP TRIGGER grounding_github_task_fence ON tasks');
  try { await expect(reserve()).rejects.toThrow(/not installed/); }
  finally { await store.db.$executeRawUnsafe('CREATE TRIGGER grounding_github_task_fence BEFORE INSERT OR UPDATE OR DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION grounding_github_task_guard()'); }
});

// This directly exercises the row-serialization primitive independently of SSI
// predicate conflicts in a particular membership query plan.
it("repository guard rejects a stale snapshot even without a membership read", async () => {
  const gate = barrier();
  const pending = store.connect().$transaction(async tx => {
    await tx.$queryRaw`SELECT version FROM grounding_github_repository_fences WHERE repo = ${f.repo}`;
    await gate.wait();
    await tx.$queryRaw`SELECT grounding_github_check(ARRAY[${f.repo}])`;
  }, { isolationLevel: "Serializable", timeout: 15000 }).then(() => "committed", e => String(e));
  await gate.reached; await reserve(); gate.release();
  expect(await pending).toMatch(/write conflict|40001|serialize/i);
});

it("raw identity remains immutable and released internal settings cannot bypass the next owner", async () => {
  await reserve();
  await expect(store.db.groundingGithubFenceIntent.update({ where: { id: f.owner.id }, data: { repo: f.other.githubRepo! } })).rejects.toThrow(/immutable/);
  await store.db.$transaction(tx => releaseGithubFence(tx, f.owner));
  await expect(store.db.groundingGithubFenceIntent.update({ where: { id: f.owner.id }, data: { state: "ACTIVE" } })).rejects.toThrow(/immutable/);
  const next = { ...f.owner, id: randomUUID() };
  await store.db.$transaction(tx => acquireGithubFence(tx, next));
  await blocked(store.db.$transaction(async tx => {
    await tx.$queryRaw`SELECT set_config('grounding.github_owner', ${f.owner.id}, true), set_config('grounding.github_repo', ${f.repo}, true), set_config('grounding.github_task', ${f.task.id}, true)`;
    return tx.task.update({ where: { id: f.task.id }, data: { title: "Stale" } });
  }));
});

it("raw operation reservations check old/new explicit repository and task membership", async () => {
  const operation = await store.db.groundingOperation.create({ data: { taskId: f.foreign.id, key: randomUUID(), actorType: "human", actorId: "test", fingerprint: "test", request: {}, decision: {}, state: "COMPLETED", repo: f.other.githubRepo } });
  await reserve();
  await blocked(store.db.groundingOperation.create({ data: { taskId: f.foreign.id, key: randomUUID(), actorType: "human", actorId: "test", fingerprint: "test", request: {}, decision: {}, state: "RESERVED", repo: f.repo } }));
  await blocked(store.db.groundingOperation.update({ where: { id: operation.id }, data: { repo: f.repo, state: "RESERVED" } }));
  await blocked(store.db.groundingOperation.update({ where: { id: operation.id }, data: { taskId: f.task.id, state: "RESERVED" } }));
  const owned = await store.db.$transaction(tx => withGithubFenceWrites(tx, f.owner, f.task.id, tx => tx.groundingOperation.create({ data: { taskId: f.task.id, key: randomUUID(), actorType: "human", actorId: "test", fingerprint: "test", request: {}, decision: {}, state: "RESERVED", repo: f.repo } })));
  await blocked(store.db.groundingOperation.delete({ where: { id: owned.id } }));
  await blocked(store.db.groundingOperation.update({ where: { id: owned.id }, data: { state: "DISPATCHED" } }));
  await store.db.$transaction(tx => withGithubFenceWrites(tx, f.owner, f.task.id, tx => tx.groundingOperation.update({ where: { id: owned.id }, data: { state: "DISPATCHED" } })));
});

it.each([Prisma.TransactionIsolationLevel.ReadCommitted, Prisma.TransactionIsolationLevel.Serializable])("%s project move is excluded after an older writer snapshot", async isolationLevel => {
  const gate = barrier();
  const pending = store.connect().$transaction(async tx => {
    await tx.project.findUniqueOrThrow({ where: { id: f.other.id } });
    await gate.wait();
    return tx.project.update({ where: { id: f.other.id }, data: { githubRepo: f.repo } });
  }, { isolationLevel, timeout: 15000 }).then(() => "committed", e => String(e));
  await gate.reached; await reserve(); gate.release();
  expect(await pending).toMatch(/grounding_github_fence_conflict|write conflict|40001|serialize/i);
  expect((await store.db.project.findUniqueOrThrow({ where: { id: f.other.id } })).githubRepo).toBe(f.other.githubRepo);
});

it.each([Prisma.TransactionIsolationLevel.ReadCommitted, Prisma.TransactionIsolationLevel.Serializable])("%s first insertion cannot bypass a fence created after its snapshot", async isolationLevel => {
  const repo = `empty/${randomUUID()}`;
  const project = await store.db.project.create({ data: { teamId, name: "Empty", slug: randomUUID(), githubRepo: repo } });
  const gate = barrier();
  const pending = store.connect().$transaction(async tx => {
    await tx.project.findUniqueOrThrow({ where: { id: project.id } }); await gate.wait();
    return tx.task.create({ data: { projectId: project.id, title: "Racing first task" } });
  }, { isolationLevel, timeout: 15000 }).then(() => "committed", e => String(e));
  await gate.reached; await store.db.$transaction(tx => acquireGithubFence(tx, { ...f.owner, repo })); gate.release();
  expect(await pending).toMatch(/grounding_github_fence_conflict|write conflict|40001|serialize/i);
  expect(await store.db.task.count({ where: { projectId: project.id } })).toBe(0);
});

it("invalid deliverable override cannot hide an active project repository", async () => {
  const malformed = await store.db.task.create({ data: { projectId: f.project.id, title: "Malformed existing", deliverableRepo: "invalid" } });
  await reserve();
  await blocked(store.db.task.create({ data: { projectId: f.project.id, title: "Malformed join", deliverableRepo: "invalid" } }));
  await blocked(store.db.task.update({ where: { id: malformed.id }, data: { title: "Changed", deliverableRepo: "still-invalid" } }));
  await blocked(store.db.task.update({ where: { id: f.foreign.id }, data: { projectId: f.project.id, deliverableRepo: "invalid" } }));
  // A valid foreign override continues to name its own independent repository.
  await store.db.task.create({ data: { projectId: f.project.id, title: "Separate deliverable", deliverableRepo: f.other.githubRepo } });
});

for (const isolationLevel of ["ReadCommitted", "Serializable"] as const) {
  it.each(["task", "project", "cohort", "binding"] as const)(`${isolationLevel} PR_CREATE task-owned identity fences an unbound %s writer with an older snapshot`, async kind => {
    await store.db.project.update({ where: { id: f.project.id }, data: { githubRepo: null } });
    await store.db.task.update({ where: { id: f.task.id }, data: { prUrl: null, prNumber: null } });
    await store.db.groundingCohort.create({ data: { ...enrollment(), mode: "EXTERNAL_V1", protected: true } });
    await store.db.groundingBinding.create({ data: binding() });
    const gate = barrier();
    const writing = store.connect().$transaction(async tx => {
      await tx.task.findUniqueOrThrow({ where: { id: f.task.id } }); await gate.wait();
      if (kind === "task") return tx.task.update({ where: { id: f.task.id }, data: { title: "Changed" } });
      if (kind === "project") return tx.project.update({ where: { id: f.project.id }, data: { githubRepo: f.other.githubRepo } });
      if (kind === "cohort") return tx.groundingCohort.update({ where: { taskId: f.task.id }, data: { provenance: "changed" } });
      return tx.groundingBinding.update({ where: { taskId: f.task.id }, data: { contextRevision: { increment: 1 } } });
    }, { isolationLevel, timeout: 15000 }).then(() => "committed", e => String(e));
    await gate.reached;
    const before = await store.db.task.findUniqueOrThrow({ where: { id: f.task.id } });
    await store.db.$transaction(tx => acquireGithubFence(tx, { ...f.owner, kind: "PR_CREATE" }));
    expect(await store.db.task.findUniqueOrThrow({ where: { id: f.task.id } })).toEqual(before);
    gate.release(); expect(await writing).toMatch(/grounding_github_fence_conflict|write conflict|40001|serialize/i);
  });
}

it("an older snapshot cannot report an unbound task as unfenced after PR_CREATE acquires it", async () => {
  await store.db.project.update({ where: { id: f.project.id }, data: { githubRepo: null } });
  await store.db.task.update({ where: { id: f.task.id }, data: { prUrl: null, prNumber: null } });
  const gate = barrier();
  const lookup = store.connect().$transaction(async tx => {
    await tx.task.findUniqueOrThrow({ where: { id: f.task.id } }); await gate.wait();
    const [row] = await tx.$queryRaw<{ repos: string[] }[]>`SELECT grounding_github_task_repos(t) AS repos FROM tasks t WHERE id = ${f.task.id}`;
    return row.repos.includes(f.repo) ? "guarded" : "unfenced";
  }, { isolationLevel: "Serializable", timeout: 15000 }).catch(error => String(error));
  await gate.reached;
  await store.db.$transaction(tx => acquireGithubFence(tx, { ...f.owner, kind: "PR_CREATE" }));
  gate.release(); expect(await lookup).toMatch(/guarded|write conflict|40001|serialize/i);
});

it("PR_CREATE cannot own the same task under two repositories; exact-owner acquisition stays idempotent", async () => {
  await store.db.project.update({ where: { id: f.project.id }, data: { githubRepo: null } });
  await store.db.task.update({ where: { id: f.task.id }, data: { prUrl: null, prNumber: null } });
  const owner = { ...f.owner, kind: "PR_CREATE" as const };
  await store.db.$transaction(tx => acquireGithubFence(tx, owner));
  await store.db.$transaction(tx => acquireGithubFence(tx, owner));
  await expect(store.db.$transaction(tx => acquireGithubFence(tx, { ...owner, id: randomUUID(), repo: f.other.githubRepo! }))).rejects.toThrow(/another PR-create intent/);
  expect(await store.db.groundingGithubFenceIntent.count({ where: { taskId: f.task.id, state: "ACTIVE" } })).toBe(1);
});
