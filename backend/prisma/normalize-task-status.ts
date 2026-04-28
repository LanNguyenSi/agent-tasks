/**
 * One-shot data migration: normalize `task.status` to the fixed 4-state
 * vocabulary {open, in_progress, review, done} ahead of the schema change
 * that converts the column to a Prisma enum.
 *
 * Why: `task.status` was a free-form `String` until this PR. Custom
 * workflows could persist arbitrary names (e.g. `"shipping"`,
 * `"deployed"`), and the `task_abandon` verb wrote `"abandoned"`. After
 * the schema lock those values would cause `prisma db push` to fail (no
 * implicit cast from text to the new enum). Run this script BEFORE the
 * push to bring every row into bounds.
 *
 * Mapping:
 *   - "abandoned"  → "done"  + metadata.abandoned = true
 *   - any other foreign value → "open" + metadata.migratedFrom = "<old>"
 *     plus a Comment on the task explaining the rewrite (so users editing
 *     the task in the UI see why it suddenly shows up in a different
 *     column).
 *
 * Idempotent: re-running is safe. Tasks already in the 4-state set are
 * skipped; tasks that have `metadata.migratedFrom` set are also skipped.
 *
 * Usage (manual):
 *   npx tsx backend/prisma/normalize-task-status.ts
 *
 * Usage (Dockerfile.migrate): runs automatically before `prisma db push`.
 */
import { PrismaClient } from "@prisma/client";

interface Metadata {
  [key: string]: unknown;
}

// Exported so tests can call it without re-importing the module (which
// would re-run the trailing `main().catch(...)` line below). Keeps the
// CLI behaviour intact: when this file is run via tsx, the IIFE at the
// bottom invokes main() exactly once.
export async function main() {
  const prisma = new PrismaClient();
  try {
    // Use raw SQL for the discovery query so this script doesn't break
    // after the schema change (when `task.status` becomes an enum and
    // the foreign-status rows can no longer exist).
    const rows = await prisma.$queryRaw<
      Array<{ id: string; status: string; metadata: Metadata | null; project_id: string }>
    >`
      SELECT id, status, metadata, "projectId" AS project_id
      FROM tasks
      WHERE status NOT IN ('open', 'in_progress', 'review', 'done')
    `;

    if (rows.length === 0) {
      console.log("normalize-task-status: no foreign-status tasks");
    } else {
      console.log(`normalize-task-status: found ${rows.length} task(s) with foreign status`);
    }

    let abandonedCount = 0;
    let otherCount = 0;

    for (const row of rows) {
      const oldStatus = row.status;
      const meta: Metadata = (row.metadata as Metadata | null) ?? {};

      if (oldStatus === "abandoned") {
        // task_abandon used to write status='abandoned'. Fold into done
        // with a metadata flag so consumers can still distinguish.
        await prisma.task.update({
          where: { id: row.id },
          data: {
            status: "done",
            metadata: {
              ...meta,
              abandoned: true,
              migratedFrom: "abandoned",
            },
          },
        });
        abandonedCount++;
      } else {
        // Custom-workflow leftover. Send back to open so the user can
        // re-route through the now-fixed transition graph; record the
        // old name in metadata + a comment so they understand why.
        await prisma.task.update({
          where: { id: row.id },
          data: {
            status: "open",
            metadata: {
              ...meta,
              migratedFrom: oldStatus,
            },
          },
        });
        await prisma.comment.create({
          data: {
            taskId: row.id,
            authorUserId: null,
            authorAgentId: null,
            content:
              `[system] Status migrated from "${oldStatus}" to "open". ` +
              `agent-tasks now uses a fixed 4-state model (open / in_progress / review / done). ` +
              `The original state name is preserved in metadata.migratedFrom.`,
          },
        });
        otherCount++;
      }

      await prisma.auditLog.create({
        data: {
          action: "task.status_migrated",
          taskId: row.id,
          projectId: row.project_id,
          payload: {
            from: oldStatus,
            to: oldStatus === "abandoned" ? "done" : "open",
            reason: "fixed-4-state-model-migration",
          },
        },
      });
    }

    console.log(
      `normalize-task-status: migrated ${abandonedCount} abandoned + ${otherCount} foreign-status task(s)`,
    );

    // Phase 1B — neutralize Workflow rows whose definition references state
    // names outside the 4-state set. After this PR `resolveEffectiveDefinition`
    // still honors `task.workflowId`; if the resolved definition contained a
    // foreign state name, the engine would later try to write that name into
    // the now-locked enum column and trip a Prisma constraint error. Delete
    // the offending Workflow rows and null out the dependent `task.workflowId`
    // so the engine falls back to the built-in default workflow.
    const allWorkflows = await prisma.$queryRaw<
      Array<{ id: string; project_id: string; definition: unknown }>
    >`
      SELECT id, "projectId" AS project_id, definition
      FROM workflows
    `;

    const offendingWorkflowIds: string[] = [];
    for (const wf of allWorkflows) {
      const def = wf.definition as
        | {
            states?: Array<{ name?: string }>;
            transitions?: Array<{ from?: string; to?: string }>;
            initialState?: string;
          }
        | null;
      if (!def) continue;
      const names = new Set<string>();
      if (typeof def.initialState === "string") names.add(def.initialState);
      for (const s of def.states ?? []) {
        if (typeof s.name === "string") names.add(s.name);
      }
      for (const t of def.transitions ?? []) {
        if (typeof t.from === "string") names.add(t.from);
        if (typeof t.to === "string") names.add(t.to);
      }
      const foreign = [...names].filter(
        (n) => !["open", "in_progress", "review", "done"].includes(n),
      );
      if (foreign.length > 0) {
        offendingWorkflowIds.push(wf.id);
        await prisma.task.updateMany({
          where: { workflowId: wf.id },
          data: { workflowId: null },
        });
        await prisma.auditLog.create({
          data: {
            action: "workflow.reset",
            projectId: wf.project_id,
            payload: {
              workflowId: wf.id,
              foreignStateNames: foreign,
              reason: "fixed-4-state-model-migration",
            },
          },
        });
      }
    }

    if (offendingWorkflowIds.length > 0) {
      await prisma.workflow.deleteMany({
        where: { id: { in: offendingWorkflowIds } },
      });
      console.log(
        `normalize-task-status: deleted ${offendingWorkflowIds.length} Workflow row(s) with foreign state names; affected tasks now use the built-in default workflow`,
      );
    } else {
      console.log("normalize-task-status: no Workflow rows with foreign state names");
    }
  } finally {
    await prisma.$disconnect();
  }
}

// CLI entrypoint. Skips when imported (tests, type checks).
// process.argv[1] mirrors the resolved entrypoint when run via `tsx`.
const isEntrypoint = process.argv[1]?.includes("normalize-task-status");
if (isEntrypoint) {
  main().catch((err) => {
    console.error("normalize-task-status failed:", err);
    process.exit(1);
  });
}
