import { Prisma, type PrismaClient } from "@prisma/client";
import { parseGroundingRuntimeConfig } from "../config/grounding-runtime.js";
import { GroundingAttemptsService, type GroundingAttemptsConfig } from "./grounding-attempts.js";
import { GroundingGithubMergeService } from "./grounding-github-merge.js";
import { GroundingGithubCreateService } from "./grounding-github-create.js";
import { GroundingMigrationService } from "./grounding-migration.js";
import { assertGithubFenceInstalled, canonicalGithubRepo } from "./grounding-github-fence.js";
import { groundingSettings } from "./grounding-verification.js";
import type { GroundingEnforcedScope } from "./grounding-scope.js";
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
      // The GitHub repository-fence trigger (grounding-github-fence.sql) fires
      // on every ordinary task write that carries a GitHub repo, whether or
      // not grounding is ever configured, bumping an unowned
      // grounding_github_repository_fences row. Only such an unowned fence row
      // is exempted below; an owned fence, and any row at all in
      // grounding_github_fence_intents or another grounding table, is still
      // grounding history.
      const predicates = groundingStateTables.map(table => {
        if (table === "grounding_github_repository_fences") return Prisma.sql`EXISTS (SELECT 1 FROM grounding_github_repository_fences WHERE "ownerId" IS NOT NULL)`;
        return Prisma.sql`EXISTS (SELECT 1 FROM ${Prisma.raw(table)})`;
      });
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
    const projects = await db.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, githubRepo: true } });
    if (projects.length !== projectIds.length) throw new Error("Unknown grounding project");
    // Enforced scope = the creationPolicy project ids, plus the canonical
    // GitHub repos those same projects own. A repo an unscoped project also
    // claims would make enforcement ambiguous at the repo boundary, so
    // startup refuses that configuration outright rather than ever
    // resolving it per-request. A stored repository that is not a canonical
    // identity cannot be compared at all (it may be an escaped alias of an
    // enforced repository), so it refuses startup too: on an enforced
    // project always, and on any project whenever the scope owns a
    // repository. Projects created or re-pointed after startup are not
    // re-validated.
    const enforcedProjectIds = new Set(projectIds);
    const enforcedRepos = new Set<string>();
    for (const project of projects) {
      if (project.githubRepo === null) continue;
      try { enforcedRepos.add(canonicalGithubRepo(project.githubRepo)); } catch { throw new Error("Grounding enforced project has a non-canonical repository"); }
    }
    if (enforcedRepos.size > 0) {
      const conflicts = await db.$queryRaw<{ id: string }[]>`
        SELECT p.id FROM projects p
        WHERE p.id NOT IN (${Prisma.join([...enforcedProjectIds])})
          AND grounding_github_repo(p."githubRepo") IN (${Prisma.join([...enforcedRepos])})
      `;
      if (conflicts.length > 0) throw new Error("Grounding enforced project shares a repository with an unscoped project");
      const unresolved = await db.$queryRaw<{ id: string }[]>`
        SELECT p.id FROM projects p WHERE p."githubRepo" IS NOT NULL AND grounding_github_repo(p."githubRepo") IS NULL LIMIT 1
      `;
      if (unresolved.length > 0) throw new Error("Grounding scope cannot compare a non-canonical project repository");
    }
    const scope: GroundingEnforcedScope = Object.freeze({ projectIds: enforcedProjectIds, repos: enforcedRepos });
    return {
      attempts: new GroundingAttemptsService({ db, config }),
      completion: {
        db, service: new GroundingGithubMergeService({ db, config }),
        githubCreate: new GroundingGithubCreateService({ db }), creationPolicy: runtime.creationPolicy, scope,
      },
      migration: new GroundingMigrationService({ db, config }),
    };
  } catch { throw new Error("Grounding runtime startup refused"); }
}
