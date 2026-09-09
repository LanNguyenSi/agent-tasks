import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GroundingAttemptsService } from "../../src/services/grounding-attempts.js";
import { provisionGroundingCohort } from "../../src/services/grounding-cohort.js";
import { mutateGroundingRouteContext, presentGroundingRouteContext, selectGroundingRouteContext } from "../../src/services/grounding-route-context.js";
import { barrier, groundingPostgres } from "../helpers/grounding-postgres.js";
import { testIssuer } from "../helpers/grounding-fixtures.js";

let store: Awaited<ReturnType<typeof groundingPostgres>>;

async function waitForTaskLock(observer: typeof store.db, blockedPid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = await observer.$queryRaw<{ wait_event_type: string | null }[]>`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${blockedPid}`;
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("provision did not wait on the presentation task lock");
}

async function taskFixture() {
  const projectId = randomUUID();
  const taskId = randomUUID();
  const teamId = randomUUID();
  await store.db.team.create({ data: { id: teamId, name: `Team ${teamId}`, slug: `team-${teamId}` } });
  await store.db.project.create({
    data: { id: projectId, teamId, name: "Route context", slug: `project-${projectId}` },
  });
  await store.db.task.create({ data: { id: taskId, projectId, title: "Route context", status: "open" } });
  return { projectId, taskId };
}

async function provisionActiveAttempt(input: { taskId: string; projectId: string }) {
  const attempts = new GroundingAttemptsService({
    db: store.db,
    config: { audience: "consumer.test", trust: () => testIssuer([input.projectId]).trust },
  });
  await attempts.provision({ ...input, subjectMode: "TASK_SPEC" });
  const binding = await store.db.groundingBinding.findUniqueOrThrow({ where: { taskId: input.taskId } });
  const attemptId = randomUUID();
  await store.db.groundingAttempt.create({
    data: {
      id: attemptId,
      taskId: input.taskId,
      contextRevision: binding.contextRevision,
      contextDigest: "a".repeat(64),
      contextBytes: Buffer.from("route-context"),
      target: { action: "finish" },
      intent: "finish",
      nonce: randomUUID(),
      actorType: "agent",
      actorId: "route-context-test",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  await store.db.groundingBinding.update({
    where: { taskId: input.taskId },
    data: { activeAttemptId: attemptId, contextDigest: "a".repeat(64) },
  });
  return attemptId;
}

const routeActor = {
  type: "agent" as const,
  tokenId: "route-context-test",
  teamId: "route-context-test",
  userId: "route-context-test",
  scopes: ["tasks:transition"],
};

beforeAll(async () => { store = await groundingPostgres(); }, 60000);
afterAll(async () => { await store?.close(); });

describe("grounding route context (PostgreSQL)", () => {
  it("selects EXTERNAL_V1 only from its protected cohort and binding", async () => {
    const { taskId, projectId } = await taskFixture();
    const attempts = new GroundingAttemptsService({
      db: store.db,
      config: { audience: "consumer.test", trust: () => testIssuer([projectId]).trust },
    });
    await attempts.provision({ taskId, projectId, subjectMode: "TASK_SPEC" });

    await expect(selectGroundingRouteContext(store.db, { taskId, projectId }))
      .resolves.toEqual({ mode: "EXTERNAL_V1" });
  });

  it("keeps unprovisioned, LEGACY_LOCAL, and OFF distinct", async () => {
    const unprovisioned = await taskFixture();
    await expect(selectGroundingRouteContext(store.db, unprovisioned))
      .resolves.toEqual({ mode: "UNPROVISIONED" });

    const legacy = await taskFixture();
    await provisionGroundingCohort(store.db, {
      ...legacy,
      cohort: {
        mode: "LEGACY_LOCAL",
        protected: true,
        provenance: "test-server",
        legacySessionId: "legacy.session",
        legacyPhase: "claim-evaluation",
      },
    });
    await expect(selectGroundingRouteContext(store.db, legacy))
      .resolves.toEqual({ mode: "LEGACY_LOCAL" });

    const off = await taskFixture();
    await provisionGroundingCohort(store.db, {
      ...off,
      cohort: {
        mode: "OFF",
        protected: false,
        provenance: "test-server",
        legacySessionId: null,
        legacyPhase: null,
      },
    });
    await expect(selectGroundingRouteContext(store.db, off))
      .resolves.toEqual({ mode: "OFF" });
  });

  it("fails closed for an orphan external binding", async () => {
    const { taskId, projectId } = await taskFixture();
    await store.db.groundingBinding.create({
      data: {
        taskId,
        projectId,
        audience: "consumer.test",
        protected: true,
        subjectMode: "TASK_SPEC",
        policyId: "grounding-receipt/v1",
        policyRevision: "1",
        policySha256: "a".repeat(64),
      },
    });

    await expect(selectGroundingRouteContext(store.db, { taskId, projectId }))
      .rejects.toMatchObject({ code: "grounding_verification_unavailable" });
  });

  it("serializes legacy presentation before concurrent external enrollment", async () => {
    const { taskId, projectId } = await taskFixture();
    const rendezvous = barrier();
    const present = presentGroundingRouteContext(store.db, {
      taskId,
      projectId,
      present: async (_task, context) => {
        expect(context).toEqual({ mode: "UNPROVISIONED" });
        await rendezvous.wait();
        return "legacy-session-initialized";
      },
    });
    await rendezvous.reached;

    const connection = store.connect();
    const [{ pid }] = await connection.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    const attempts = new GroundingAttemptsService({
      db: connection,
      config: { audience: "consumer.test", trust: () => testIssuer([projectId]).trust },
    });
    let provisioned = false;
    const provision = attempts.provision({ taskId, projectId, subjectMode: "TASK_SPEC" })
      .then(() => { provisioned = true; });

    // A second PostgreSQL connection has started provisioning but cannot pass
    // the parent/task lock held by the presentation transaction.
    await waitForTaskLock(store.connect(), pid);
    expect(provisioned).toBe(false);
    rendezvous.release();
    await expect(present).resolves.toMatchObject({ value: "legacy-session-initialized" });
    await provision;
    await expect(selectGroundingRouteContext(store.db, { taskId, projectId }))
      .resolves.toEqual({ mode: "EXTERNAL_V1" });
  });

  it("invalidates claim acquire/release/reopen, preserves a no-op retry, and blocks both behind a reservation", async () => {
    const input = await taskFixture();
    const project = await store.db.project.findUniqueOrThrow({ where: { id: input.projectId } });
    routeActor.teamId = project.teamId;
    await store.db.user.create({ data: { id: routeActor.userId, login: "route-context" } });
    await store.db.agentToken.create({ data: { id: routeActor.tokenId, teamId: project.teamId, createdById: routeActor.userId, name: "Route context", tokenHash: "route-context", scopes: routeActor.scopes } });
    const activeAttemptId = await provisionActiveAttempt(input);

    await expect(mutateGroundingRouteContext(store.db, {
      ...input,
      actor: routeActor,
      reason: "route_claim_acquire",
      revalidate: async () => undefined,
      mutate: async db => {
        const value = await db.task.updateMany({ where: { id: input.taskId, status: "open" }, data: { status: "in_progress" } });
        return { value, changed: value.count === 1 };
      },
    })).resolves.toMatchObject({ changed: true });

    const invalidated = await store.db.groundingBinding.findUniqueOrThrow({ where: { taskId: input.taskId } });
    expect(invalidated).toMatchObject({ activeAttemptId: null, contextDigest: null, contextRevision: 2 });
    await expect(store.db.groundingAttempt.findUniqueOrThrow({ where: { id: activeAttemptId } }))
      .resolves.toMatchObject({ state: "SUPERSEDED" });

    const releaseAttemptId = await provisionActiveAttempt(input);
    await expect(mutateGroundingRouteContext(store.db, {
      ...input,
      actor: routeActor,
      reason: "route_claim_release",
      revalidate: async () => undefined,
      mutate: async db => {
        const value = await db.task.updateMany({ where: { id: input.taskId, status: "in_progress" }, data: { status: "open" } });
        return { value, changed: value.count === 1 };
      },
    })).resolves.toMatchObject({ changed: true });
    await expect(store.db.groundingAttempt.findUniqueOrThrow({ where: { id: releaseAttemptId } }))
      .resolves.toMatchObject({ state: "SUPERSEDED" });

    await store.db.task.update({ where: { id: input.taskId }, data: { status: "abandoned" } });
    const reopenAttemptId = await provisionActiveAttempt(input);
    await expect(mutateGroundingRouteContext(store.db, {
      ...input,
      actor: routeActor,
      reason: "route_unabandon",
      revalidate: async () => undefined,
      mutate: async db => {
        const value = await db.task.updateMany({ where: { id: input.taskId, status: "abandoned" }, data: { status: "open" } });
        return { value, changed: value.count === 1 };
      },
    })).resolves.toMatchObject({ changed: true });
    await expect(store.db.groundingAttempt.findUniqueOrThrow({ where: { id: reopenAttemptId } }))
      .resolves.toMatchObject({ state: "SUPERSEDED" });

    const retryAttemptId = await provisionActiveAttempt(input);
    const auditBeforeNoop = await store.db.auditLog.count({ where: { projectId: input.projectId, action: "project.grounding.context_mutated" } });
    await expect(mutateGroundingRouteContext(store.db, {
      ...input,
      actor: routeActor,
      reason: "route_claim_noop",
      revalidate: async () => undefined,
      mutate: async () => ({ value: { count: 0 }, changed: false }),
    })).resolves.toMatchObject({ changed: false });
    const afterNoop = await store.db.groundingBinding.findUniqueOrThrow({ where: { taskId: input.taskId } });
    expect(afterNoop.activeAttemptId).toBe(retryAttemptId);
    await expect(store.db.groundingAttempt.findUniqueOrThrow({ where: { id: retryAttemptId } }))
      .resolves.toMatchObject({ state: "ACTIVE" });
    expect(await store.db.auditLog.count({ where: { projectId: input.projectId, action: "project.grounding.context_mutated" } })).toBe(auditBeforeNoop);

    const operation = await store.db.groundingOperation.create({
      data: {
        id: randomUUID(), taskId: input.taskId, key: randomUUID(), actorType: "agent", actorId: routeActor.tokenId,
        fingerprint: "b".repeat(64), request: {}, decision: {}, state: "RESERVED",
      },
    });
    await store.db.groundingCohort.update({ where: { taskId: input.taskId }, data: { reservationId: operation.id } });
    await expect(mutateGroundingRouteContext(store.db, {
      ...input,
      actor: routeActor,
      reason: "route_claim_reserved_noop",
      revalidate: async () => undefined,
      mutate: async () => ({ value: { count: 0 }, changed: false }),
    })).rejects.toMatchObject({ code: "grounding_finalization_pending", status: 409 });
  });
});
