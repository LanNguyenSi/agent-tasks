/**
 * Read-only grounding migration inventory.
 *
 * The report is deliberately an inventory, not a migration command. It uses a
 * repeatable, read-only PostgreSQL snapshot and returns aggregate counts only:
 * no task dossiers, session identifiers, receipt bytes, or credentials leave
 * the database query.
 */
import { Prisma, PrismaClient } from "@prisma/client";
import { pathToFileURL } from "node:url";
import { defaultWorkflowDefinition, isReviewState, isTerminalState, type WorkflowDefinitionShape } from "../services/default-workflow.js";

type Cohort = "UNPROVISIONED" | "OFF" | "LEGACY_LOCAL" | "EXTERNAL_V1" | "INCONSISTENT";
type Lifecycle = "work" | "review" | "terminal";

export interface GroundingMigrationProjectReport {
  projectId: string;
  project: string;
  requireGroundingForDebug: boolean;
  tasks: number;
  cohorts: Record<Cohort, number>;
  lifecycle: Record<Lifecycle, number>;
  debug: { debug: number; nondebug: number };
  legacyPhaseDiagnostics: {
    withSession: number;
    missingSession: number;
    malformedSession: number;
    malformedPhase: number;
    impossiblePhase: number;
    completePhase: number;
  };
  remote: { unresolvedOperations: number; autoMergeSha: number };
  recommendedActions: Record<string, number>;
}

export interface GroundingMigrationReport {
  inventoryOnly: true;
  projects: GroundingMigrationProjectReport[];
  totals: Omit<GroundingMigrationProjectReport, "projectId" | "project" | "requireGroundingForDebug">;
}

interface Row {
  projectId: string;
  projectSlug: string;
  requireGroundingForDebug: boolean;
  taskId: string | null;
  status: string;
  hasReviewClaim: boolean;
  hasAutoMergeSha: boolean;
  isDebug: boolean;
  hasLegacySession: boolean;
  hasMalformedMetadataSession: boolean;
  hasMalformedMetadataPhase: boolean;
  metadataPhase: string | null;
  cohortMode: "OFF" | "LEGACY_LOCAL" | "EXTERNAL_V1" | null;
  cohortProjectId: string | null;
  cohortProtected: boolean | null;
  cohortLegacySessionIsValid: boolean | null;
  cohortLegacyPhaseIsValid: boolean | null;
  cohortPhase: string | null;
  cohortLegacySessionIsNull: boolean;
  cohortLegacyPhaseIsNull: boolean;
  cohortProvenanceIsValid: boolean;
  bindingProjectId: string | null;
  bindingProtected: boolean | null;
  hasUnresolvedRemoteOperation: boolean;
  taskWorkflow: unknown;
  taskWorkflowProjectId: string | null;
  defaultWorkflows: unknown;
}

const cohorts = ["UNPROVISIONED", "OFF", "LEGACY_LOCAL", "EXTERNAL_V1", "INCONSISTENT"] as const;
const lifecycles = ["work", "review", "terminal"] as const;

class MigrationArgumentError extends Error {}

function emptyCounts<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map(key => [key, 0])) as Record<T, number>;
}

function emptyProject(projectId: string, project: string, requireGroundingForDebug: boolean): GroundingMigrationProjectReport {
  return {
    projectId,
    project,
    requireGroundingForDebug,
    tasks: 0,
    cohorts: emptyCounts(cohorts),
    lifecycle: emptyCounts(lifecycles),
    debug: { debug: 0, nondebug: 0 },
    legacyPhaseDiagnostics: { withSession: 0, missingSession: 0, malformedSession: 0, malformedPhase: 0, impossiblePhase: 0, completePhase: 0 },
    remote: { unresolvedOperations: 0, autoMergeSha: 0 },
    recommendedActions: {},
  };
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function effectiveWorkflow(row: Row): WorkflowDefinitionShape {
  if (row.taskWorkflow !== null) {
    if (row.taskWorkflowProjectId !== row.projectId) throw new Error("Inventory cannot classify a cross-project task workflow");
    return parseWorkflow(row.taskWorkflow);
  }
  if (row.defaultWorkflows === null) return defaultWorkflowDefinition();
  if (!Array.isArray(row.defaultWorkflows)) throw new Error("Inventory cannot classify a malformed project default workflow");
  if (row.defaultWorkflows.length === 0) return defaultWorkflowDefinition();
  if (row.defaultWorkflows.length !== 1) throw new Error("Inventory cannot classify multiple project default workflows");
  return parseWorkflow(row.defaultWorkflows[0]);
}

function parseWorkflow(value: unknown): WorkflowDefinitionShape {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Inventory cannot classify an invalid workflow definition");
  const definition = value as Partial<WorkflowDefinitionShape>;
  if (typeof definition.initialState !== "string" || !Array.isArray(definition.states) || !Array.isArray(definition.transitions))
    throw new Error("Inventory cannot classify an invalid workflow definition");
  const states = definition.states as Array<{ name?: unknown; terminal?: unknown }>;
  if (!states.length || states.some(state => typeof state?.name !== "string" || !state.name || typeof state.terminal !== "boolean"))
    throw new Error("Inventory cannot classify invalid workflow states");
  const names = new Set(states.map(state => state.name as string));
  if (names.size !== states.length || !names.has(definition.initialState)) throw new Error("Inventory cannot classify invalid workflow states");
  if ((definition.transitions as unknown[]).some(transition => !transition || typeof transition !== "object" ||
    !names.has((transition as { from?: unknown }).from as string) || !names.has((transition as { to?: unknown }).to as string)))
    throw new Error("Inventory cannot classify invalid workflow transitions");
  return definition as WorkflowDefinitionShape;
}

function lifecycleOf(row: Row): Lifecycle {
  const workflow = effectiveWorkflow(row);
  if (row.status === "backlog") return "work";
  if (row.status === "abandoned") return "terminal";
  if (!workflow.states.some(state => state.name === row.status)) throw new Error("Inventory cannot classify an unknown task status");
  if (isTerminalState(workflow, row.status)) return "terminal";
  if (isReviewState(workflow, row.status) || row.hasReviewClaim) return "review";
  return "work";
}

function cohortOf(row: Row): Cohort {
  if (!row.cohortMode && !row.bindingProjectId) return "UNPROVISIONED";
  if (!row.cohortMode || !row.bindingProjectId && row.cohortMode === "EXTERNAL_V1") return "INCONSISTENT";
  if (row.cohortProjectId !== row.projectId || row.bindingProjectId && row.bindingProjectId !== row.projectId) return "INCONSISTENT";
  if (row.cohortMode === "EXTERNAL_V1") return row.cohortProtected && row.bindingProtected && row.cohortLegacySessionIsNull && row.cohortLegacyPhaseIsNull && row.cohortProvenanceIsValid ? "EXTERNAL_V1" : "INCONSISTENT";
  if (row.bindingProjectId) return "INCONSISTENT";
  if (row.cohortMode === "OFF") return row.cohortProtected === false && row.cohortLegacySessionIsNull && row.cohortLegacyPhaseIsNull && row.cohortProvenanceIsValid ? "OFF" : "INCONSISTENT";
  return row.cohortLegacySessionIsValid && row.cohortLegacyPhaseIsValid && row.cohortProvenanceIsValid ? "LEGACY_LOCAL" : "INCONSISTENT";
}

const legacyPhases = new Set([
  "scope-resolution", "doc-reading", "playbook-loading", "runtime-inspection",
  "evidence-collection", "claim-evaluation", "complete",
]);

function recordLegacyPhaseDiagnostics(report: GroundingMigrationProjectReport, row: Row, cohort: Cohort): boolean {
  const unprovisionedLegacy = cohort === "UNPROVISIONED" && row.isDebug;
  const persistedLegacy = row.cohortMode === "LEGACY_LOCAL";
  if (!unprovisionedLegacy && !persistedLegacy) return false;
  const hasSession = unprovisionedLegacy ? row.hasLegacySession : row.cohortLegacySessionIsValid === true;
  const phase = unprovisionedLegacy ? row.metadataPhase : row.cohortPhase;
  const malformedSession = unprovisionedLegacy ? row.hasMalformedMetadataSession : row.cohortLegacySessionIsValid !== true;
  const malformedPhase = unprovisionedLegacy ? row.hasMalformedMetadataPhase : row.cohortLegacyPhaseIsValid !== true;
  if (hasSession) report.legacyPhaseDiagnostics.withSession++;
  else report.legacyPhaseDiagnostics.missingSession++;
  if (malformedSession) report.legacyPhaseDiagnostics.malformedSession++;
  if (malformedPhase) report.legacyPhaseDiagnostics.malformedPhase++;
  if (phase && !legacyPhases.has(phase)) report.legacyPhaseDiagnostics.impossiblePhase++;
  if (phase === "complete") report.legacyPhaseDiagnostics.completePhase++;
  return malformedSession || malformedPhase || phase === "complete" || (phase !== null && !legacyPhases.has(phase));
}

function actionFor(row: Row, cohort: Cohort, legacyPhaseNeedsRepair: boolean): string {
  if (legacyPhaseNeedsRepair) return "RECOMMEND_HOLD_LEGACY_STATE_REPAIR";
  if (cohort === "INCONSISTENT") return "HOLD_INCONSISTENT_COHORT_BINDING";
  if (cohort === "UNPROVISIONED") {
    if (row.isDebug && row.hasLegacySession) return "REVIEW_UNPROVISIONED_LEGACY";
    if (row.isDebug) return "REVIEW_UNPROVISIONED_DEBUG";
    return "NO_MIGRATION_UNPROVISIONED";
  }
  return `RECOMMEND_INVENTORY_ONLY_${cohort}`;
}

const inventoryQuery = (projectFilter?: string) => Prisma.sql`
  SELECT
    p.id AS "projectId",
    p.slug AS "projectSlug",
    p."requireGroundingForDebug",
    t.id AS "taskId",
    t.status,
    (t."reviewClaimedAt" IS NOT NULL) AS "hasReviewClaim",
    (t."autoMergeSha" IS NOT NULL) AS "hasAutoMergeSha",
    (jsonb_typeof(t.metadata) = 'object' AND t.metadata -> 'debugFlavor' = 'true'::jsonb) AS "isDebug",
    (jsonb_typeof(t.metadata) = 'object' AND jsonb_typeof(t.metadata -> 'groundingSessionId') = 'string' AND COALESCE(t.metadata ->> 'groundingSessionId', '') <> '') AS "hasLegacySession",
    (
      jsonb_typeof(t.metadata) = 'object'
      AND t.metadata ? 'groundingSessionId'
      AND NOT (jsonb_typeof(t.metadata -> 'groundingSessionId') = 'string' AND COALESCE(t.metadata ->> 'groundingSessionId', '') <> '')
    ) AS "hasMalformedMetadataSession",
    (
      jsonb_typeof(t.metadata) = 'object'
      AND jsonb_typeof(t.metadata -> 'groundingSessionId') = 'string'
      AND COALESCE(t.metadata ->> 'groundingSessionId', '') <> ''
      AND NOT (
        jsonb_typeof(t.metadata -> 'groundingSessionState') = 'object'
        AND jsonb_typeof(t.metadata -> 'groundingSessionState' -> 'current_phase') = 'string'
        AND COALESCE(t.metadata -> 'groundingSessionState' ->> 'current_phase', '') <> ''
      )
    ) AS "hasMalformedMetadataPhase",
    CASE WHEN jsonb_typeof(t.metadata -> 'groundingSessionState' -> 'current_phase') = 'string'
      THEN t.metadata -> 'groundingSessionState' ->> 'current_phase' ELSE NULL END AS "metadataPhase",
    c.mode::text AS "cohortMode",
    c."projectId" AS "cohortProjectId",
    c.protected AS "cohortProtected",
    (c."legacySessionId" ~ '^[A-Za-z0-9._:-]{1,128}$') AS "cohortLegacySessionIsValid",
    (c."legacyPhase" ~ '^[A-Za-z0-9._:-]{1,128}$') AS "cohortLegacyPhaseIsValid",
    c."legacyPhase" AS "cohortPhase",
    (c."legacySessionId" IS NULL) AS "cohortLegacySessionIsNull",
    (c."legacyPhase" IS NULL) AS "cohortLegacyPhaseIsNull",
    (c.provenance ~ '^[A-Za-z0-9._:-]{1,128}$') AS "cohortProvenanceIsValid",
    b."projectId" AS "bindingProjectId",
    b.protected AS "bindingProtected",
    EXISTS (
      SELECT 1 FROM grounding_operations operation
      WHERE operation."taskId" = t.id AND operation.state IN ('RESERVED', 'DISPATCHED')
    ) AS "hasUnresolvedRemoteOperation",
    CASE WHEN w.id IS NULL THEN NULL ELSE jsonb_build_object(
      'initialState', w.definition -> 'initialState',
      'states', w.definition -> 'states',
      'transitions', w.definition -> 'transitions'
    ) END AS "taskWorkflow",
    w."projectId" AS "taskWorkflowProjectId",
    defaults.definitions AS "defaultWorkflows"
  FROM projects p
  LEFT JOIN tasks t ON t."projectId" = p.id
  LEFT JOIN grounding_cohorts c ON c."taskId" = t.id
  LEFT JOIN grounding_bindings b ON b."taskId" = t.id
  LEFT JOIN workflows w ON w.id = t."workflowId"
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'initialState', definition -> 'initialState',
      'states', definition -> 'states',
      'transitions', definition -> 'transitions'
    )) AS definitions
    FROM workflows
    WHERE "projectId" = p.id AND "isDefault" = true
  ) defaults ON true
  ${projectFilter ? Prisma.sql`WHERE p.id = ${projectFilter} OR p.slug = ${projectFilter}` : Prisma.empty}
  ORDER BY p.slug ASC, t.id ASC
`;

/** Uses only a repeatable, read-only snapshot; it cannot perform a migration. */
export async function computeGroundingMigrationReport(db: PrismaClient, projectFilter?: string): Promise<GroundingMigrationReport> {
  const rows = await db.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return tx.$queryRaw<Row[]>(inventoryQuery(projectFilter));
  });

  const byProject = new Map<string, GroundingMigrationProjectReport>();
  for (const row of rows) {
    const report = byProject.get(row.projectId) ?? emptyProject(row.projectId, row.projectSlug, row.requireGroundingForDebug);
    byProject.set(row.projectId, report);
    if (!row.taskId) continue;
    const cohort = cohortOf(row);
    const lifecycle = lifecycleOf(row);
    const legacyPhaseNeedsRepair = recordLegacyPhaseDiagnostics(report, row, cohort);

    report.tasks++;
    report.cohorts[cohort]++;
    report.lifecycle[lifecycle]++;
    report.debug[row.isDebug ? "debug" : "nondebug"]++;
    if (row.hasUnresolvedRemoteOperation) report.remote.unresolvedOperations++;
    if (row.hasAutoMergeSha) report.remote.autoMergeSha++;
    increment(report.recommendedActions, actionFor(row, cohort, legacyPhaseNeedsRepair));
  }

  const totals = emptyProject("all", "all", false);
  for (const report of byProject.values()) {
    totals.tasks += report.tasks;
    for (const cohort of cohorts) totals.cohorts[cohort] += report.cohorts[cohort];
    for (const lifecycle of lifecycles) totals.lifecycle[lifecycle] += report.lifecycle[lifecycle];
    totals.debug.debug += report.debug.debug;
    totals.debug.nondebug += report.debug.nondebug;
    totals.legacyPhaseDiagnostics.withSession += report.legacyPhaseDiagnostics.withSession;
    totals.legacyPhaseDiagnostics.missingSession += report.legacyPhaseDiagnostics.missingSession;
    totals.legacyPhaseDiagnostics.malformedSession += report.legacyPhaseDiagnostics.malformedSession;
    totals.legacyPhaseDiagnostics.malformedPhase += report.legacyPhaseDiagnostics.malformedPhase;
    totals.legacyPhaseDiagnostics.impossiblePhase += report.legacyPhaseDiagnostics.impossiblePhase;
    totals.legacyPhaseDiagnostics.completePhase += report.legacyPhaseDiagnostics.completePhase;
    totals.remote.unresolvedOperations += report.remote.unresolvedOperations;
    totals.remote.autoMergeSha += report.remote.autoMergeSha;
    for (const [action, count] of Object.entries(report.recommendedActions)) totals.recommendedActions[action] = (totals.recommendedActions[action] ?? 0) + count;
  }
  const { projectId: _projectId, project: _project, requireGroundingForDebug: _flag, ...totalReport } = totals;
  return { inventoryOnly: true, projects: [...byProject.values()], totals: totalReport };
}

export function parseGroundingMigrationArguments(args: readonly string[]): { project?: string } {
  let project: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") continue;
    if (arg === "--project" && !project) {
      const value = args[++index];
      if (!value || value.startsWith("-")) throw new MigrationArgumentError("--project requires a project id or slug");
      project = value;
      continue;
    }
    throw new MigrationArgumentError(`Unknown argument: ${arg}`);
  }
  return project ? { project } : {};
}

async function main(): Promise<void> {
  const { project } = parseGroundingMigrationArguments(process.argv.slice(2));
  const datasourceUrl = process.env.GROUNDING_MIGRATION_DATABASE_URL;
  if (!datasourceUrl) throw new MigrationArgumentError("GROUNDING_MIGRATION_DATABASE_URL is required");
  const db = new PrismaClient({ datasourceUrl });
  try {
    console.log(JSON.stringify(await computeGroundingMigrationReport(db, project), null, 2));
  } finally {
    await db.$disconnect();
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(error => {
    console.error(error instanceof MigrationArgumentError ? error.message : "Grounding migration inventory failed");
    process.exitCode = 1;
  });
}
