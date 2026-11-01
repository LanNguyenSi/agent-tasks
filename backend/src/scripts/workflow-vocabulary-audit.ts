/**
 * Persisted workflow vocabulary audit. READ-ONLY.
 *
 * Counts the stored `Workflow` rows that carry
 *   - a `backlog` state, an edge from or to `backlog`, or `initialState`
 *     `backlog` (the shape of the retired coding-agent template; the reads
 *     sanitize such a row, see `sanitizeStoredDefinition`), and/or
 *   - state names outside the four built-ins (`open`, `in_progress`,
 *     `review`, `done`), which the workflow API accepts since custom state
 *     names were unlocked.
 *
 * The two headings are counted separately: `backlog` never counts as an
 * "other" name, so a row is in `rowsWithOtherNames` only for a name that is
 * neither `backlog` nor one of the four. For each affected row the report
 * also gives the number of tasks pinned to it (`Task.workflowId`).
 *
 * Run:
 *   npm run audit:workflow-vocabulary --workspace=backend
 *   npm run audit:workflow-vocabulary --workspace=backend -- --json
 *
 * Writes nothing: only `findMany` and `count` calls, safe against production.
 */
import { pathToFileURL } from "node:url";
import { prisma } from "../lib/prisma.js";

export const BUILT_IN_STATE_NAMES = ["open", "in_progress", "review", "done"] as const;
const BUILT_IN = new Set<string>(BUILT_IN_STATE_NAMES);

export interface WorkflowRowInput {
  id: string;
  projectId: string;
  name: string;
  isDefault: boolean;
  definition: unknown;
}

export interface AffectedWorkflowRow {
  id: string;
  projectId: string;
  name: string;
  isDefault: boolean;
  /** The row declares a `backlog` state, an edge with `backlog` at either end, or `initialState` `backlog`. */
  hasBacklog: boolean;
  /** State names other than `backlog` that are not one of the four built-ins, sorted. */
  outsideBuiltIns: string[];
  /** Tasks whose `workflowId` is this row. Filled in by `auditWorkflowVocabulary`. */
  pinnedTasks: number;
}

export interface WorkflowVocabularyAudit {
  totalRows: number;
  /** Rows whose definition could not be read as states and transitions. */
  unreadableRows: number;
  rowsWithBacklog: number;
  /** Rows with at least one state name that is neither `backlog` nor a built-in. */
  rowsWithOtherNames: number;
  /** Rows counted under at least one of the two headings. */
  affectedRows: number;
  affected: AffectedWorkflowRow[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Classifies one stored row; null when the definition is not readable. */
export function classifyWorkflowRow(row: WorkflowRowInput): Omit<AffectedWorkflowRow, "pinnedTasks"> | null | "unreadable" {
  const def = asRecord(row.definition);
  if (!def || !Array.isArray(def.states) || !Array.isArray(def.transitions)) return "unreadable";
  const names = def.states.flatMap((s) => {
    const name = asRecord(s)?.name;
    return typeof name === "string" ? [name] : [];
  });
  const edgeEnds = def.transitions.flatMap((t) => {
    const e = asRecord(t);
    return e ? [e.from, e.to] : [];
  });
  const hasBacklog = names.includes("backlog") || edgeEnds.includes("backlog") || def.initialState === "backlog";
  const outsideBuiltIns = [...new Set(names.filter((n) => n !== "backlog" && !BUILT_IN.has(n)))].sort();
  if (!hasBacklog && outsideBuiltIns.length === 0) return null;
  return { id: row.id, projectId: row.projectId, name: row.name, isDefault: row.isDefault, hasBacklog, outsideBuiltIns };
}

interface AuditClient {
  workflow: { findMany(args: { select: Record<string, true>; orderBy: Record<string, "asc"> }): Promise<WorkflowRowInput[]> };
  task: { count(args: { where: { workflowId: string } }): Promise<number> };
}

export async function auditWorkflowVocabulary(client: AuditClient = prisma as unknown as AuditClient): Promise<WorkflowVocabularyAudit> {
  const rows = await client.workflow.findMany({
    select: { id: true, projectId: true, name: true, isDefault: true, definition: true },
    orderBy: { id: "asc" },
  });
  const affected: AffectedWorkflowRow[] = [];
  let unreadableRows = 0;
  for (const row of rows) {
    const verdict = classifyWorkflowRow(row);
    if (verdict === "unreadable") unreadableRows++;
    else if (verdict) {
      affected.push({ ...verdict, pinnedTasks: await client.task.count({ where: { workflowId: row.id } }) });
    }
  }
  return {
    totalRows: rows.length,
    unreadableRows,
    rowsWithBacklog: affected.filter((r) => r.hasBacklog).length,
    rowsWithOtherNames: affected.filter((r) => r.outsideBuiltIns.length > 0).length,
    affectedRows: affected.length,
    affected,
  };
}

export function formatAudit(audit: WorkflowVocabularyAudit): string {
  const lines = [
    "Persisted workflow vocabulary audit (read-only)",
    `built-in state names: ${BUILT_IN_STATE_NAMES.join(", ")}`,
    `workflow rows:                                      ${audit.totalRows}`,
    `rows with a backlog state, edge or initialState:    ${audit.rowsWithBacklog}`,
    `rows with other state names (not built-in, not backlog): ${audit.rowsWithOtherNames}`,
    `rows counted under either heading:                  ${audit.affectedRows}`,
    `rows with an unreadable definition:                 ${audit.unreadableRows}`,
  ];
  for (const r of audit.affected) {
    lines.push(
      `- workflow ${r.id} (project ${r.projectId}, "${r.name}", ${r.isDefault ? "default" : "non-default"}): ` +
        `backlog=${r.hasBacklog ? "yes" : "no"}, other names=[${r.outsideBuiltIns.join(", ")}], pinned tasks=${r.pinnedTasks}`,
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const json = process.argv.slice(2).includes("--json");
  const audit = await auditWorkflowVocabulary();
  console.log(json ? JSON.stringify(audit, null, 2) : formatAudit(audit));
  await prisma.$disconnect();
}

// Run only when invoked directly (tsx/node), not when imported by a test.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
}
