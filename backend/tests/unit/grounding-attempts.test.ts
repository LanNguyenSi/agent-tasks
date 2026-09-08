import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, it, expect, vi } from "vitest";
vi.mock("../../src/services/team-access.js", () => ({ requireProjectWrite: vi.fn(), hasProjectRole: vi.fn() }));
vi.mock("../../src/services/github-delegation.js", () => ({ findDelegationUser: vi.fn() }));
import { GroundingAttemptsService } from "../../src/services/grounding-attempts.js";
import { actor, ids, epoch, session, taskFixture, bindingFixture, testIssuer } from "../helpers/grounding-fixtures.js";

function setup() {
  const task = taskFixture(); const binding = bindingFixture(); const issuer = testIssuer();
  const mock = {
    $transaction: vi.fn(), $queryRaw: vi.fn(async () => [{ id: ids.project }]), task: { findUnique: vi.fn(async () => task) },
    groundingCohort: { findUnique: vi.fn(async () => ({ taskId: ids.task, projectId: ids.project, mode: "EXTERNAL_V1", protected: true, provenance: "external-binding:v1", legacySessionId: null, legacyPhase: null, reservationId: null })) },
    workflow: { findMany: vi.fn(async () => []) }, groundingBinding: { findUnique: vi.fn(async () => binding), updateMany: vi.fn(), create: vi.fn() },
    groundingAttempt: { findUnique: vi.fn(async () => null), updateMany: vi.fn(), create: vi.fn() },
  };
  mock.$transaction.mockImplementation(async (fn: (db: unknown) => unknown) => fn(mock));
  const authority = { canWrite: vi.fn(async () => true), hasRole: vi.fn(async () => true) };
  const headProvider = vi.fn(async () => "a".repeat(40));
  const config = { audience: "consumer.test", trust: () => issuer.trust };
  const service = new GroundingAttemptsService({ db: mock as unknown as PrismaClient, config, now: () => epoch, authority, headProvider });
  return { service, mock, authority, config, task, headProvider };
}

describe("grounding attempts fail-closed service boundary", () => {
  it("N-23 storage outage never produces a challenge or accepted receipt", async () => {
    const { service, mock, headProvider } = setup(); mock.$transaction.mockRejectedValue(new Error("database offline"));
    await expect(service.issue(ids.task, actor, "finish")).rejects.toMatchObject({ code: "grounding_verification_unavailable" });
    await expect(service.ingest(ids.task, ids.project, actor, session, "{}" )).rejects.toMatchObject({ code: "grounding_verification_unavailable" });
    expect(headProvider).not.toHaveBeenCalled();
  });
  it("serialization retries are bounded and do not silently accept exhausted CAS", async () => {
    const { service, mock } = setup();
    mock.$transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("conflict", { code: "P2034", clientVersion: "test" }));
    await expect(service.issue(ids.task, actor, "finish")).rejects.toMatchObject({ code: "grounding_verification_unavailable" });
    expect(mock.$transaction).toHaveBeenCalledTimes(3);
  });
  it.each(["40001", "40P01", "42501"])("retries only recognized raw SQL conflict %s", async sqlstate => {
    const { service, mock } = setup();
    mock.$transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("raw failure", { code: "P2010", meta: { code: sqlstate }, clientVersion: "test" }));
    await expect(service.issue(ids.task, actor, "finish")).rejects.toMatchObject({ code: "grounding_verification_unavailable" });
    expect(mock.$transaction).toHaveBeenCalledTimes(sqlstate === "42501" ? 1 : 3);
  });
  it("scope/project/claim denial precedes locks, provider and attempt diagnostics", async () => {
    for (const mode of ["scope", "project", "claim"] as const) {
      const { service, mock, task, authority, headProvider } = setup();
      if (mode === "project") authority.canWrite.mockResolvedValue(false);
      if (mode === "claim") task.claimedByAgentId = null;
      const requester = mode === "scope" ? { ...actor, scopes: [] } : actor;
      await expect(service.ingest(ids.task, ids.project, requester, session, "{}" )).rejects.toMatchObject({ code: "forbidden" });
      expect(mock.$queryRaw).not.toHaveBeenCalled(); expect(mock.groundingAttempt.findUnique).not.toHaveBeenCalled(); expect(headProvider).not.toHaveBeenCalled();
    }
  });
  it("N-07 provision never derives authority from metadata and rejects a conflicting protected binding", async () => {
    const { service, mock } = setup();
    await expect(service.provision({ taskId: ids.task, projectId: ids.project, subjectMode: "CODE_HEAD" })).resolves.toMatchObject({ protected: true });
    await expect(service.provision({ taskId: ids.task, projectId: ids.project, subjectMode: "TASK_SPEC" })).rejects.toMatchObject({ code: "grounding_receipt_mismatch" });
    expect(mock.groundingBinding.create).not.toHaveBeenCalled();
  });
  it("rejects wrong inputs, unavailable operator config and a missing binding", async () => {
    const { service, mock, config } = setup();
    await expect(service.issue(ids.task, actor, "invented" as "finish")).rejects.toMatchObject({ code: "bad_state" });
    await expect(service.ingest(ids.task, ids.project, actor, session, "x".repeat(32769))).rejects.toMatchObject({ code: "grounding_receipt_invalid" });
    await expect(service.ingest(ids.task, ids.project, actor, session, "\ud800")).rejects.toMatchObject({ code: "grounding_receipt_invalid" });
    config.audience = "invalid audience";
    await expect(service.issue(ids.task, actor, "finish")).rejects.toMatchObject({ code: "grounding_verification_unavailable" });
    mock.groundingBinding.findUnique.mockResolvedValue(null as never);
    await expect(service.issue(ids.task, actor, "finish")).rejects.toMatchObject({ code: "grounding_not_provisioned" });
  });
});
