/**
 * The persisted workflow vocabulary audit against a real database: it counts
 * stored rows with a `backlog` state, edge or initialState and rows with state
 * names outside the four built-ins, and it writes nothing.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditWorkflowVocabulary, formatAudit } from "../../src/scripts/workflow-vocabulary-audit.js";
import { defaultWorkflowDefinition } from "../../src/services/default-workflow.js";
import { HELD_WORKFLOW_TEMPLATES } from "../../src/services/workflow-templates.js";
import { groundingPostgres } from "../helpers/grounding-postgres.js";

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
const ids: Record<string, string> = {};

async function seedWorkflow(key: string, projectId: string, definition: unknown, isDefault = true) {
  const id = randomUUID();
  ids[key] = id;
  await db.workflow.create({ data: { id, projectId, name: key, isDefault, definition: definition as never } });
  return id;
}

async function seedProject(teamId: string) {
  const id = randomUUID();
  await db.project.create({ data: { id, teamId, name: `P-${id.slice(0, 8)}`, slug: randomUUID() } });
  return id;
}

beforeAll(async () => {
  store = await groundingPostgres();
  db = store.db;
  const userId = randomUUID();
  await db.user.create({ data: { id: userId, login: `u-${userId}` } });
  const teamId = randomUUID();
  await db.team.create({ data: { id: teamId, name: "Audit", slug: randomUUID() } });

  // Built-in four states: not affected.
  await seedWorkflow("builtin", await seedProject(teamId), defaultWorkflowDefinition());
  // Registered template with custom names and no backlog.
  const template = JSON.parse(JSON.stringify(HELD_WORKFLOW_TEMPLATES[0]!.definition));
  const templateProject = await seedProject(teamId);
  await seedWorkflow("template", templateProject, template);
  await db.task.create({
    data: { projectId: templateProject, workflowId: ids.template, title: "Pinned", status: "spec", createdByUserId: userId },
  });
  // Earlier backlog-shaped definition: backlog state, backlog initialState, edges to and from backlog, custom names.
  const legacyProject = await seedProject(teamId);
  await seedWorkflow("legacy", legacyProject, {
    initialState: "backlog",
    states: [
      { name: "backlog", label: "Backlog", terminal: false },
      { name: "spec", label: "Spec", terminal: false },
      { name: "done", label: "Done", terminal: true },
    ],
    transitions: [
      { from: "backlog", to: "spec" },
      { from: "spec", to: "backlog" },
      { from: "spec", to: "done" },
    ],
  });
  // Two tasks of the legacy project follow its default row without naming it; a backlog task counts too.
  for (const status of ["spec", "backlog"]) {
    await db.task.create({ data: { projectId: legacyProject, title: "Implicit", status, createdByUserId: userId } });
  }
  // Built-in names but an edge to backlog and no backlog state: backlog only.
  await seedWorkflow("edge-only", await seedProject(teamId), {
    initialState: "open",
    states: [
      { name: "open", label: "Open", terminal: false },
      { name: "done", label: "Done", terminal: true },
    ],
    transitions: [{ from: "open", to: "done" }, { from: "done", to: "backlog" }],
  });
  // Custom names without backlog, non-default row.
  await seedWorkflow("custom-only", await seedProject(teamId), {
    initialState: "open",
    states: [
      { name: "open", label: "Open", terminal: false },
      { name: "shipped", label: "Shipped", terminal: true },
    ],
    transitions: [{ from: "open", to: "shipped" }],
  }, false);
  // Not a definition at all.
  await seedWorkflow("garbage", await seedProject(teamId), { nothing: true });
}, 60000);

afterAll(async () => {
  if (store) await store.close();
});

describe("auditWorkflowVocabulary", () => {
  it("counts the rows under each heading and lists the affected ones", async () => {
    const audit = await auditWorkflowVocabulary(db as never);
    expect(audit).toMatchObject({
      totalRows: 6,
      unreadableRows: 1,
      rowsWithBacklog: 2,
      rowsWithOtherNames: 3,
      affectedRows: 4,
    });
    const byId = new Map(audit.affected.map((r) => [r.id, r]));
    expect(byId.has(ids.builtin!)).toBe(false);
    expect(byId.has(ids.garbage!)).toBe(false);
    expect(byId.get(ids.template!)).toMatchObject({
      hasBacklog: false,
      outsideBuiltIns: ["implement", "plan", "spec", "test"],
      pinnedTasks: 1,
      implicitTasks: 0,
      isDefault: true,
    });
    expect(byId.get(ids.legacy!)).toMatchObject({ hasBacklog: true, outsideBuiltIns: ["spec"], pinnedTasks: 0, implicitTasks: 2 });
    expect(byId.get(ids["edge-only"]!)).toMatchObject({ hasBacklog: true, outsideBuiltIns: [] });
    expect(byId.get(ids["custom-only"]!)).toMatchObject({ hasBacklog: false, outsideBuiltIns: ["shipped"], isDefault: false, pinnedTasks: 0, implicitTasks: 0 });
  });

  it("writes nothing: the row and task counts and the stored definitions are unchanged", async () => {
    const snapshot = async () => ({
      workflows: await db.workflow.findMany({ orderBy: { id: "asc" } }),
      tasks: await db.task.count(),
    });
    const before = await snapshot();
    await auditWorkflowVocabulary(db as never);
    expect(await snapshot()).toEqual(before);
  });

  it("prints a summary with the counts and one line per affected row", async () => {
    const text = formatAudit(await auditWorkflowVocabulary(db as never));
    expect(text).toContain("workflow rows:");
    expect(text).toContain("pinned tasks=1, implicit tasks=0");
    expect(text).toContain("pinned tasks=0, implicit tasks=2");
    expect(text).toContain(`workflow ${ids.legacy} `);
    expect(text).not.toContain(`workflow ${ids.builtin} `);
    expect(text.match(/^- workflow /gm)).toHaveLength(4);
  });
});
