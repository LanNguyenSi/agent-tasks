import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeGroundingMigrationReport, parseGroundingMigrationArguments } from "../../src/scripts/grounding-migration-report.js";
import { groundingPostgres } from "../helpers/grounding-postgres.js";

let store: Awaited<ReturnType<typeof groundingPostgres>> | undefined;

async function task(data: { status?: string; metadata?: object; autoMergeSha?: string | null; workflowId?: string | null }) {
  return store!.db.task.create({ data: {
    id: randomUUID(), projectId: "project-required", title: randomUUID(), status: data.status ?? "working",
    metadata: data.metadata, autoMergeSha: data.autoMergeSha, workflowId: data.workflowId,
  } });
}

beforeAll(async () => {
  store = await groundingPostgres();
  await store.db.team.create({ data: { id: "team", name: "Grounding", slug: "grounding" } });
  await store.db.project.createMany({ data: [
    { id: "project-required", teamId: "team", name: "Required", slug: "required", requireGroundingForDebug: true },
    { id: "project-optional", teamId: "team", name: "Optional", slug: "optional", requireGroundingForDebug: false },
    { id: "project-empty", teamId: "team", name: "Empty", slug: "empty", requireGroundingForDebug: false },
  ] });

  const workflow = await store.db.workflow.create({ data: { projectId: "project-required", name: "Lifecycle", definition: { initialState: "working", states: [{ name: "working", terminal: false }, { name: "shipped", terminal: true }], transitions: [{ from: "working", to: "shipped" }] } } });
  await task({ metadata: { debugFlavor: true } });
  await task({ metadata: { debugFlavor: true, groundingSessionId: "session-secret", groundingSessionState: { current_phase: "claim-evaluation" }, dossier: "must-not-appear" } });
  await task({ metadata: { debugFlavor: true, groundingSessionId: "malformed-secret", groundingSessionState: { current_phase: 4 } } });
  await task({ metadata: { debugFlavor: true, groundingSessionId: "complete-secret", groundingSessionState: { current_phase: "complete" } } });
  await task({ metadata: { debugFlavor: false } });

  const external = await task({ metadata: { debugFlavor: true }, autoMergeSha: "a".repeat(40) });
  await store.db.groundingCohort.create({ data: { taskId: external.id, projectId: external.projectId, mode: "EXTERNAL_V1", protected: true, provenance: "test", legacySessionId: null, legacyPhase: null } });
  await store.db.groundingBinding.create({ data: { taskId: external.id, projectId: external.projectId, audience: "test", protected: true, subjectMode: "TASK_SPEC", policyId: "p", policyRevision: "r", policySha256: "b".repeat(64) } });
  await store.db.groundingOperation.create({ data: { taskId: external.id, key: "remote", actorType: "test", actorId: "test", fingerprint: "test", request: {}, decision: {}, state: "DISPATCHED" } });

  const off = await task({ status: "done", metadata: { debugFlavor: false } });
  await store.db.groundingCohort.create({ data: { taskId: off.id, projectId: off.projectId, mode: "OFF", protected: false, provenance: "test", legacySessionId: null, legacyPhase: null } });
  const legacy = await task({ status: "shipped", workflowId: workflow.id, metadata: { debugFlavor: true } });
  await store.db.groundingCohort.create({ data: { taskId: legacy.id, projectId: legacy.projectId, mode: "LEGACY_LOCAL", protected: true, provenance: "test", legacySessionId: "legacy-secret", legacyPhase: "complete" } });
  const inconsistent = await task({ metadata: { debugFlavor: true } });
  await store.db.groundingCohort.create({ data: { taskId: inconsistent.id, projectId: inconsistent.projectId, mode: "EXTERNAL_V1", protected: true, provenance: "test", legacySessionId: null, legacyPhase: null } });

  await store.db.task.create({ data: { id: "optional-task", projectId: "project-optional", title: "Optional", status: "review", metadata: { debugFlavor: false } } });
});

afterAll(async () => { await store?.close(); });

describe("grounding migration inventory", () => {
  it("classifies persisted and unprovisioned cohorts without outputting sensitive metadata or writing", async () => {
    const db = store!.db;
    const writeTarget = await db.task.findFirstOrThrow({ where: { projectId: "project-required" } });
    const readerRole = `grounding_reader_${randomUUID().replaceAll("-", "")}`;
    const readerUrl = new URL(store!.datasourceUrl);
    readerUrl.username = readerRole;
    readerUrl.password = "test-reader-password";
    let reader: PrismaClient | undefined;
    await db.$executeRawUnsafe(`CREATE ROLE "${readerRole}" LOGIN PASSWORD 'test-reader-password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    try {
      await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${store!.schema}" TO "${readerRole}"`);
      await db.$executeRawUnsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA "${store!.schema}" TO "${readerRole}"`);
      reader = new PrismaClient({ datasourceUrl: readerUrl.toString() });
      const report = await computeGroundingMigrationReport(reader);
      await expect(reader.task.update({ where: { id: writeTarget.id }, data: { title: "must-not-write" } })).rejects.toThrow();
      const after = await db.task.findUniqueOrThrow({ where: { id: writeTarget.id } });

      expect(after).toEqual(writeTarget);
      expect(report.inventoryOnly).toBe(true);
      expect(report.totals.cohorts).toMatchObject({ UNPROVISIONED: 6, OFF: 1, LEGACY_LOCAL: 1, EXTERNAL_V1: 1, INCONSISTENT: 1 });
      expect(report.totals.lifecycle).toMatchObject({ work: 7, review: 1, terminal: 2 });
      expect(report.totals.debug).toEqual({ debug: 7, nondebug: 3 });
      expect(report.totals.legacyPhaseDiagnostics).toEqual({ withSession: 4, missingSession: 1, malformedPhase: 1, impossiblePhase: 2, completePhase: 2 });
      expect(report.totals.remote).toEqual({ unresolvedOperations: 1, autoMergeSha: 1 });
      expect(report.totals.recommendedActions).toMatchObject({ HOLD_INCONSISTENT_COHORT_BINDING: 1, RECOMMEND_HOLD_LEGACY_STATE_REPAIR: 2, REVIEW_UNPROVISIONED_LEGACY: 1 });
      expect(report.projects.map(project => [project.project, project.requireGroundingForDebug])).toEqual([["empty", false], ["optional", false], ["required", true]]);
      expect(report.projects.find(project => project.project === "empty")?.tasks).toBe(0);
      expect(JSON.stringify(report)).not.toMatch(/session-secret|malformed-secret|complete-secret|legacy-secret|must-not-appear|a{40}/);
    } finally {
      await reader?.$disconnect();
      await db.$executeRawUnsafe(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "${store!.schema}" FROM "${readerRole}"`);
      await db.$executeRawUnsafe(`REVOKE USAGE ON SCHEMA "${store!.schema}" FROM "${readerRole}"`);
      await db.$executeRawUnsafe(`DROP ROLE IF EXISTS "${readerRole}"`);
    }
  });

  it("accepts only JSON output and an optional project selector", () => {
    expect(parseGroundingMigrationArguments(["--json", "--project", "required"])).toEqual({ project: "required" });
    expect(() => parseGroundingMigrationArguments(["--project"])).toThrow("--project requires");
    expect(() => parseGroundingMigrationArguments(["--live"])).toThrow("Unknown argument");
  });
});
