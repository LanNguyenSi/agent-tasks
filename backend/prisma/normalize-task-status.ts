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

async function main() {
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
      console.log("normalize-task-status: no foreign statuses found, nothing to do");
      return;
    }

    console.log(`normalize-task-status: found ${rows.length} task(s) with foreign status`);

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
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("normalize-task-status failed:", err);
  process.exit(1);
});
