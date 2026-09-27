import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeGroundingMigrationReport, parseGroundingMigrationArguments } from "../../src/scripts/grounding-migration-report.js";
import { groundingPostgres } from "../helpers/grounding-postgres.js";

let store: Awaited<ReturnType<typeof groundingPostgres>> | undefined;

async function task(data: { projectId?: string; status?: string; metadata?: object; autoMergeSha?: string | null; workflowId?: string | null }) {
  return store!.db.task.create({ data: {
    id: randomUUID(), projectId: data.projectId ?? "project-required", title: randomUUID(), status: data.status ?? "in_progress",
    metadata: data.metadata, autoMergeSha: data.autoMergeSha, workflowId: data.workflowId,
  } });
}

beforeAll(async () => {
  store = await groundingPostgres();
  await store.db.team.create({ data: { id: "team", name: "Grounding", slug: "grounding" } });
  await store.db.team.create({ data: { id: "other-team", name: "Other", slug: "other-grounding" } });
  await store.db.project.createMany({ data: [
    { id: "project-required", teamId: "team", name: "Required", slug: "required", requireGroundingForDebug: true },
    { id: "project-optional", teamId: "team", name: "Optional", slug: "optional", requireGroundingForDebug: false },
    { id: "project-empty", teamId: "team", name: "Empty", slug: "empty", requireGroundingForDebug: false },
    { id: "project-required-duplicate", teamId: "other-team", name: "Required duplicate", slug: "required", requireGroundingForDebug: false },
  ] });

  const workflow = await store.db.workflow.create({ data: { projectId: "project-required", name: "Lifecycle", definition: { initialState: "working", states: [{ name: "working", terminal: false }, { name: "shipped", terminal: true }], transitions: [{ from: "working", to: "shipped" }] } } });
  await store.db.workflow.create({ data: { projectId: "project-optional", name: "Default", isDefault: true, definition: { initialState: "open", states: [{ name: "open", terminal: false }, { name: "in_progress", terminal: false }, { name: "review", terminal: false }, { name: "done", terminal: true }], transitions: [{ from: "open", to: "in_progress" }, { from: "in_progress", to: "review" }, { from: "review", to: "done" }] } } });
  await task({ metadata: { debugFlavor: true } });
  await task({ metadata: { debugFlavor: true, groundingSessionId: "session-secret", groundingSessionState: { current_phase: "claim-evaluation" }, dossier: "must-not-appear" } });
  await task({ metadata: { debugFlavor: true, groundingSessionId: "malformed-secret", groundingSessionState: { current_phase: 4 } } });
  await task({ metadata: { debugFlavor: true, groundingSessionId: "complete-secret", groundingSessionState: { current_phase: "complete" } } });
  await task({ metadata: { debugFlavor: true, groundingSessionId: null, groundingSessionState: { current_phase: "scope-resolution" } } });
  await task({ metadata: { debugFlavor: true, groundingSessionId: 4, groundingSessionState: { current_phase: ["scope-resolution"] } } });
  await task({ metadata: { debugFlavor: false } });
  await task({ projectId: "project-optional", status: "backlog", metadata: { debugFlavor: false } });
  await task({ projectId: "project-optional", status: "abandoned", metadata: { debugFlavor: false } });
  for (const phase of ["scope-resolution", "doc-reading", "playbook-loading", "runtime-inspection", "evidence-collection", "claim-evaluation", "complete"]) {
    await task({ metadata: { debugFlavor: true, groundingSessionId: `metadata-${phase}`, groundingSessionState: { current_phase: phase } } });
  }
  for (const phase of ["doc-resolution", "hypothesis-tracking", "playbook-execution", "post-incident-review"]) {
    await task({ metadata: { debugFlavor: true, groundingSessionId: `historical-${phase}`, groundingSessionState: { current_phase: phase } } });
  }

  const external = await task({ metadata: { debugFlavor: true }, autoMergeSha: "a".repeat(40) });
  await store.db.groundingCohort.create({ data: { taskId: external.id, projectId: external.projectId, mode: "EXTERNAL_V1", protected: true, provenance: "test", legacySessionId: null, legacyPhase: null } });
  await store.db.groundingBinding.create({ data: { taskId: external.id, projectId: external.projectId, audience: "test", protected: true, subjectMode: "TASK_SPEC", policyId: "p", policyRevision: "r", policySha256: "b".repeat(64) } });
  await store.db.groundingOperation.create({ data: { taskId: external.id, key: "remote", actorType: "test", actorId: "test", fingerprint: "test", request: {}, decision: {}, state: "DISPATCHED" } });

  const off = await task({ status: "done", metadata: { debugFlavor: false } });
  await store.db.groundingCohort.create({ data: { taskId: off.id, projectId: off.projectId, mode: "OFF", protected: false, provenance: "test", legacySessionId: null, legacyPhase: null } });
  const legacy = await task({ status: "shipped", workflowId: workflow.id, metadata: { debugFlavor: true } });
  await store.db.groundingCohort.create({ data: { taskId: legacy.id, projectId: legacy.projectId, mode: "LEGACY_LOCAL", protected: true, provenance: "test", legacySessionId: "legacy-secret", legacyPhase: "complete" } });
  const unprotectedLegacy = await task({ metadata: { debugFlavor: false } });
  await store.db.groundingCohort.create({ data: { taskId: unprotectedLegacy.id, projectId: unprotectedLegacy.projectId, mode: "LEGACY_LOCAL", protected: false, provenance: "test", legacySessionId: "legacy-unprotected", legacyPhase: "scope-resolution" } });
  for (const phase of ["scope-resolution", "doc-reading", "playbook-loading", "runtime-inspection", "evidence-collection", "claim-evaluation", "complete", "doc-resolution", "hypothesis-tracking", "playbook-execution", "post-incident-review"]) {
    const persisted = await task({ metadata: { debugFlavor: false } });
    await store.db.groundingCohort.create({ data: { taskId: persisted.id, projectId: persisted.projectId, mode: "LEGACY_LOCAL", protected: true, provenance: "test", legacySessionId: `persisted-${phase}`, legacyPhase: phase } });
  }
  const malformedPersisted = await task({ metadata: { debugFlavor: false } });
  await store.db.groundingCohort.create({ data: { taskId: malformedPersisted.id, projectId: malformedPersisted.projectId, mode: "LEGACY_LOCAL", protected: true, provenance: "bad provenance", legacySessionId: "bad session", legacyPhase: "" } });
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
      expect(report.totals.cohorts).toMatchObject({ OFF: 1, EXTERNAL_V1: 1, LEGACY_LOCAL: 13, INCONSISTENT: 2 });
      expect(report.totals.lifecycle.terminal).toBe(3);
      expect(report.totals.debug.debug).toBeGreaterThan(7);
      expect(report.totals.legacyPhaseDiagnostics).toMatchObject({ malformedSession: 3, malformedPhase: 2, impossiblePhase: 8, completePhase: 4 });
      expect(report.totals.remote).toEqual({ unresolvedOperations: 1, autoMergeSha: 1 });
      expect(report.totals.recommendedActions.RECOMMEND_HOLD_LEGACY_STATE_REPAIR).toBe(12);
      expect(report.projects.map(project => [project.projectId, project.project, project.requireGroundingForDebug])).toEqual([
        ["project-empty", "empty", false], ["project-optional", "optional", false], ["project-required", "required", true], ["project-required-duplicate", "required", false],
      ]);
      expect(report.projects.find(project => project.project === "empty")?.tasks).toBe(0);
      expect(JSON.stringify(report)).not.toMatch(/session-secret|malformed-secret|complete-secret|legacy-secret|metadata-|persisted-|must-not-appear|a{40}/);
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

  it("rejects cross-project, malformed, and unknown workflow status rows", async () => {
    const db = store!.db;
    const foreign = await db.workflow.create({ data: { projectId: "project-required", name: "Foreign", definition: { initialState: "open", states: [{ name: "open", terminal: false }], transitions: [] } } });
    const cross = await task({ projectId: "project-optional", workflowId: foreign.id, status: "open" });
    await expect(computeGroundingMigrationReport(db)).rejects.toThrow("cross-project");
    await db.task.delete({ where: { id: cross.id } }); await db.workflow.delete({ where: { id: foreign.id } });

    const malformed = await db.workflow.create({ data: { projectId: "project-required", name: "Malformed", definition: { initialState: "open", states: [{ name: "open", terminal: "no" }], transitions: [] } } });
    const malformedTask = await task({ workflowId: malformed.id, status: "open" });
    await expect(computeGroundingMigrationReport(db)).rejects.toThrow("invalid workflow states");
    await db.task.delete({ where: { id: malformedTask.id } }); await db.workflow.delete({ where: { id: malformed.id } });

    const unknown = await task({ status: "unknown-status" });
    await expect(computeGroundingMigrationReport(db)).rejects.toThrow("unknown task status");
    await db.task.delete({ where: { id: unknown.id } });
  });
});
