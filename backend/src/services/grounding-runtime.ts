import { Prisma, type PrismaClient } from "@prisma/client";
import { parseGroundingRuntimeConfig } from "../config/grounding-runtime.js";
import { GroundingAttemptsService, type GroundingAttemptsConfig } from "./grounding-attempts.js";
import { GroundingGithubMergeService } from "./grounding-github-merge.js";
import { GroundingGithubCreateService } from "./grounding-github-create.js";
import { GroundingMigrationService } from "./grounding-migration.js";
import { assertGithubFenceInstalled } from "./grounding-github-fence.js";
import { groundingSettings } from "./grounding-verification.js";
import type { GroundingTaskCompletionDependencies } from "../routes/grounding-task-completion.js";

// History in any grounding table requires configured routing, even OFF, inactive
// and completed rows. Keep in sync with every Grounding model in the schema.
export const groundingStateTables = Object.freeze([
  "grounding_bindings", "grounding_attempts", "grounding_receipts", "grounding_finalizations",
  "grounding_cohorts", "grounding_operations", "grounding_github_fence_intents",
  "grounding_github_repository_fences", "grounding_github_merge_groups", "grounding_github_merge_members",
  "grounding_github_create_operations", "grounding_github_webhook_deliveries", "grounding_github_observations",
  "grounding_migration_states", "grounding_migration_commands",
]);
export interface GroundingRuntimeServices {
  attempts?: GroundingAttemptsService;
  completion?: GroundingTaskCompletionDependencies;
  migration?: GroundingMigrationService;
}

/** Read-only admission before the listener or periodic writers can start. */
export async function composeGroundingRuntime(raw: string | undefined, db: PrismaClient): Promise<GroundingRuntimeServices> {
  try {
    const runtime = parseGroundingRuntimeConfig(raw);
    if (!runtime.enabled) {
      const predicates = groundingStateTables.map(table => Prisma.sql`EXISTS (SELECT 1 FROM ${Prisma.raw(table)})`);
      const rows = await db.$queryRaw<{ present: boolean }[]>(Prisma.sql`SELECT (${Prisma.join(predicates, " OR ")}) AS present`);
      if (rows.length !== 1 || rows[0]?.present !== false) throw new Error("Grounding history requires configured startup");
      return {};
    }
    const config: GroundingAttemptsConfig = Object.freeze({
      audience: runtime.audience, challengeSeconds: runtime.challengeSeconds,
      trust: () => runtime.trust,
    });
    // Empty creation selection is deliberate; all entries still receive key and
    // scope validation above. Selected projects additionally need usable trust.
    for (const selection of runtime.creationPolicy) groundingSettings(config, selection.projectId);
    await assertGithubFenceInstalled(db);
    const projectIds = runtime.creationPolicy.map(entry => entry.projectId);
    const projects = await db.project.findMany({ where: { id: { in: projectIds } }, select: { id: true } });
    if (projects.length !== projectIds.length) throw new Error("Unknown grounding project");
    return {
      attempts: new GroundingAttemptsService({ db, config }),
      completion: {
        db, service: new GroundingGithubMergeService({ db, config }),
        githubCreate: new GroundingGithubCreateService({ db }), creationPolicy: runtime.creationPolicy,
      },
      migration: new GroundingMigrationService({ db, config }),
    };
  } catch { throw new Error("Grounding runtime startup refused"); }
}
