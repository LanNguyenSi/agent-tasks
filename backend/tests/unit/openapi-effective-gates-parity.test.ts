/**
 * Drift guard: GET /api/projects/:id/effective-gates was entirely undocumented
 * in backend/src/routes/docs.ts (no "effective-gates" or "taskCreation" string
 * in the file at all — verified during the f186b88b review, batch 16) even
 * though it's the discovery surface backing the projects_get_effective_gates
 * MCP verb. This pins the hand-written OpenAPI path + EffectiveGate /
 * TaskCreationReadiness schemas in docs.ts against the real
 * computeEffectiveGates / describeTaskCreation output, same "key parity"
 * approach as openapi-createtask-parity.test.ts, plus a full-response example
 * check so the documented example can't silently drift from the real shape.
 *
 * Scope: path presence, key parity (both schemas), the GateCode enum, and the
 * documented example value. Not a general OpenAPI-vs-Zod parity harness for
 * every path — see the file header of openapi-createtask-parity.test.ts for
 * that narrower, request-body-only pattern.
 */
import { describe, it, expect } from "vitest";
import { openApiSpec } from "../../src/routes/docs.js";
import { computeEffectiveGates, GateCode } from "../../src/services/gates/index.js";
import { describeTaskCreation } from "../../src/lib/task-creation-readiness.js";
import { GovernanceMode } from "../../src/lib/governance-mode.js";

// Same project shape as backend/tests/unit/effective-gates-endpoint.test.ts's
// "surfaces a per-task-type confidenceThreshold override (select fix)" test —
// the actual Prisma `select` shape the real route reads. Reused here rather
// than fabricating a fresh fixture, so the OpenAPI example is provably real.
const FIXTURE_PROJECT = {
  teamId: "team-1",
  githubRepo: "owner/repo",
  governanceMode: GovernanceMode.AUTONOMOUS,
  soloMode: false,
  requireDistinctReviewer: false,
  taskTemplate: null,
  enforcementMode: "BLOCK",
  confidenceThreshold: 60,
  taskTypeThresholds: { security: 90 },
};

describe("OpenAPI GET /projects/:id/effective-gates <-> real route response parity", () => {
  it("documents the path with a GET operation", () => {
    // Mutation probe target: delete this path entry from docs.ts and this
    // assertion goes red.
    expect(openApiSpec.paths).toHaveProperty("/api/projects/{id}/effective-gates");
    expect(openApiSpec.paths["/api/projects/{id}/effective-gates"].get).toBeDefined();
  });

  const schema =
    openApiSpec.paths["/api/projects/{id}/effective-gates"].get.responses["200"].content[
      "application/json"
    ].schema;

  it("documents exactly {effectiveGates, taskCreation} as the response shape", () => {
    expect(Object.keys(schema.properties).sort()).toEqual(
      ["effectiveGates", "taskCreation"].sort(),
    );
    expect([...schema.required].sort()).toEqual(["effectiveGates", "taskCreation"].sort());
  });

  it("EffectiveGate schema documents exactly the keys computeEffectiveGates returns, and every registered GateCode", () => {
    const gates = computeEffectiveGates(FIXTURE_PROJECT);
    const oneGate = gates[GateCode.DistinctReviewer];
    const effectiveGateSchema = openApiSpec.components.schemas.EffectiveGate;
    expect(Object.keys(effectiveGateSchema.properties).sort()).toEqual(
      Object.keys(oneGate).sort(),
    );
    // Catches a gate added to the registry (services/gates/index.ts) without
    // a matching OpenAPI `code` enum update.
    expect([...effectiveGateSchema.properties.code.enum].sort()).toEqual(
      Object.values(GateCode).sort(),
    );
  });

  it("TaskCreationReadiness schema documents exactly the keys describeTaskCreation returns", () => {
    const readiness = describeTaskCreation(FIXTURE_PROJECT);
    const readinessSchema = openApiSpec.components.schemas.TaskCreationReadiness;
    expect(Object.keys(readinessSchema.properties).sort()).toEqual(
      Object.keys(readiness).sort(),
    );
    expect(
      Object.keys(readinessSchema.properties.taskTypeThresholds.properties).sort(),
    ).toEqual(Object.keys(readiness.taskTypeThresholds).sort());
  });

  it("the documented example matches the real computed response for the same fixture", () => {
    const expected = {
      effectiveGates: computeEffectiveGates(FIXTURE_PROJECT),
      taskCreation: describeTaskCreation(FIXTURE_PROJECT),
    };
    expect(schema.example).toEqual(expected);
  });
});
