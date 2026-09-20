import { Prisma } from "@prisma/client";

export type GithubFenceOwner = { id: string; repo: string; kind: "MERGE" | "PR_CREATE"; taskId: string | null };
export class GithubFenceError extends Error {
  readonly code = "grounding_github_fence_conflict";
  constructor(message = "Repository operation conflicts with a durable fence") { super(message); }
}

/** GitHub identities are case insensitive. Invalid identities are never reservable. */
export function canonicalGithubRepo(value: string): string {
  const repo = value.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split("/").some(part => part === "." || part === "..")) throw new GithubFenceError("Invalid GitHub repository identity");
  return repo.toLowerCase();
}

/** Check the actual schema-local triggers, including disabled/misdirected installs. */
export async function assertGithubFenceInstalled(tx: Prisma.TransactionClient): Promise<void> {
  const rows = await tx.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) FROM (VALUES
      ('tasks', 'grounding_github_task_fence', 'grounding_github_task_guard', 31),
      ('projects', 'grounding_github_project_fence', 'grounding_github_project_guard', 27),
      ('grounding_bindings', 'grounding_github_binding_fence', 'grounding_github_enrollment_guard', 31),
      ('grounding_cohorts', 'grounding_github_cohort_fence', 'grounding_github_enrollment_guard', 31),
      ('grounding_operations', 'grounding_github_operation_fence', 'grounding_github_operation_guard', 31),
      ('grounding_github_fence_intents', 'grounding_github_intent_fence', 'grounding_github_intent_guard', 27)
    ) required(tab, trigger_name, func, bits)
    JOIN pg_namespace n ON n.nspname = current_schema()
    JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = required.tab
    JOIN pg_trigger t ON t.tgrelid = c.oid AND t.tgname = required.trigger_name
    JOIN pg_proc p ON p.oid = t.tgfoid AND p.pronamespace = n.oid AND p.proname = required.func
    WHERE NOT t.tgisinternal AND t.tgenabled IN ('O', 'A') AND t.tgtype = required.bits
      AND t.tgqual IS NULL AND p.proconfig @> ARRAY[format('search_path=%I, pg_temp', current_schema())]
  `;
  if (Number(rows[0]?.count) !== 6) throw new GithubFenceError("GitHub repository fence SQL is not installed");
}

function normalized(owner: GithubFenceOwner): GithubFenceOwner {
  if (!owner.id || (owner.kind !== "MERGE" && owner.kind !== "PR_CREATE") || (owner.taskId !== null && !owner.taskId) || (owner.kind === "PR_CREATE" && !owner.taskId)) throw new GithubFenceError("Invalid internal fence owner");
  return { ...owner, repo: canonicalGithubRepo(owner.repo) };
}

async function touch(tx: Prisma.TransactionClient, repo: string) {
  const rows = await tx.$queryRaw<{ ownerId: string | null }[]>`
    INSERT INTO grounding_github_repository_fences (repo, version) VALUES (${repo}, 1)
    ON CONFLICT (repo) DO UPDATE SET version = grounding_github_repository_fences.version + 1
    RETURNING "ownerId"
  `;
  return rows[0]!.ownerId;
}

async function exactIntent(tx: Prisma.TransactionClient, owner: GithubFenceOwner) {
  const intent = await tx.groundingGithubFenceIntent.findUnique({ where: { id: owner.id } });
  if (!intent || intent.repo !== owner.repo || intent.kind !== owner.kind || intent.taskId !== owner.taskId) throw new GithubFenceError("Internal fence owner does not match its intent");
  return intent;
}

/** A newly enrolled task-owned identity must invalidate older task/project
 * snapshots even when the task has no repo yet. Row locks alone do not do that.
 */
async function serializeCreateTask(tx: Prisma.TransactionClient, owner: GithubFenceOwner) {
  if (owner.kind !== "PR_CREATE") return;
  const before = await tx.task.findUnique({ where: { id: owner.taskId! }, select: { projectId: true } });
  if (!before) throw new GithubFenceError("Missing PR-create task");
  await tx.$queryRaw`SELECT id FROM projects WHERE id = ${before.projectId} FOR UPDATE`;
  const [task] = await tx.$queryRaw<{ projectId: string }[]>`SELECT "projectId" FROM tasks WHERE id = ${owner.taskId} FOR UPDATE`;
  if (!task || task.projectId !== before.projectId) throw new GithubFenceError("PR-create task moved while acquiring its fence");
  const other = await tx.groundingGithubFenceIntent.findFirst({ where: { taskId: owner.taskId, kind: "PR_CREATE", state: "ACTIVE", id: { not: owner.id } } });
  if (other) throw new GithubFenceError("Task already owns another PR-create intent");
  // These no-op assignments still write PostgreSQL row versions. The ordinary
  // no-op trigger path preserves the fields and does not grant write authority.
  await tx.$executeRaw`UPDATE projects SET "updatedAt" = "updatedAt" WHERE id = ${task.projectId}`;
  await tx.$executeRaw`UPDATE tasks SET "updatedAt" = "updatedAt" WHERE id = ${owner.taskId}`;
}

/** Call inside a local transaction, before discovering members or reserving tasks.
 * Commit before remote I/O. Serialization/deadlock errors abort and remain retryable
 * at the caller's complete-transaction boundary; this adapter never retries effects.
 */
export async function acquireGithubFence(tx: Prisma.TransactionClient, input: GithubFenceOwner): Promise<GithubFenceOwner> {
  const owner = normalized(input);
  await assertGithubFenceInstalled(tx);
  const active = await touch(tx, owner.repo);
  if (active !== null) {
    if (active !== owner.id || (await exactIntent(tx, owner)).state !== "ACTIVE") throw new GithubFenceError();
    await serializeCreateTask(tx, owner);
    return owner;
  }
  if (await tx.groundingGithubFenceIntent.findUnique({ where: { id: owner.id } })) throw new GithubFenceError("Released intent cannot be reacquired");
  // Older per-task reservations participate via the enrollment triggers. Check
  // after the version write so a stale transaction cannot miss their commit.
  const legacy = await tx.$queryRaw<{ id: string }[]>`
    SELECT o.id FROM grounding_operations o JOIN tasks t ON t.id = o."taskId" JOIN projects p ON p.id = t."projectId"
    WHERE o.state IN ('RESERVED', 'DISPATCHED') AND (
      grounding_github_repo(o.repo) = ${owner.repo} OR
      coalesce(grounding_github_repo(t."deliverableRepo"), grounding_github_repo(p."githubRepo")) = ${owner.repo} OR
      grounding_github_pr_repo(t."prUrl") = ${owner.repo}
    ) LIMIT 1
  `;
  if (legacy.length) throw new GithubFenceError("Existing task reservation owns this repository");
  await serializeCreateTask(tx, owner);
  await tx.groundingGithubFenceIntent.create({ data: owner });
  await tx.groundingGithubRepositoryFence.update({ where: { repo: owner.repo }, data: { ownerId: owner.id } });
  return owner;
}

export async function assertGithubFenceOwned(tx: Prisma.TransactionClient, input: GithubFenceOwner): Promise<void> {
  const owner = normalized(input);
  await assertGithubFenceInstalled(tx);
  if (await touch(tx, owner.repo) !== owner.id || (await exactIntent(tx, owner)).state !== "ACTIVE") throw new GithubFenceError();
}

/** Release only after the owning operation has completed/cancelled locally. */
export async function releaseGithubFence(tx: Prisma.TransactionClient, input: GithubFenceOwner): Promise<void> {
  const owner = normalized(input);
  await assertGithubFenceInstalled(tx);
  const active = await touch(tx, owner.repo);
  const intent = await exactIntent(tx, owner);
  if (intent.state === "RELEASED") return;
  if (intent.state !== "ACTIVE" || active !== owner.id) throw new GithubFenceError();
  await tx.groundingGithubRepositoryFence.update({ where: { repo: owner.repo }, data: { ownerId: null } });
  await tx.groundingGithubFenceIntent.update({ where: { id: owner.id }, data: { state: "RELEASED" } });
}

/** INTERNAL coordination for one operation-owned task's local effects. This is
 * not authorization: callers must validate the actor and exact operation first.
 * Never pass this helper/owner into a generic context writer or remote callback.
 */
export async function withGithubFenceWrites<T>(tx: Prisma.TransactionClient, input: GithubFenceOwner, taskId: string, write: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const owner = normalized(input);
  await assertGithubFenceOwned(tx, owner);
  if (!taskId || (owner.kind === "PR_CREATE" && taskId !== owner.taskId)) throw new GithubFenceError("Invalid operation task");
  const [previous] = await tx.$queryRaw<{ owner: string | null; repo: string | null; task: string | null }[]>`
    SELECT current_setting('grounding.github_owner', true) AS owner, current_setting('grounding.github_repo', true) AS repo, current_setting('grounding.github_task', true) AS task
  `;
  await tx.$queryRaw`SELECT set_config('grounding.github_owner', ${owner.id}, true), set_config('grounding.github_repo', ${owner.repo}, true), set_config('grounding.github_task', ${taskId}, true)`;
  try { return await write(tx); }
  finally {
    // SET LOCAL also resets on commit/rollback and never survives pool reuse.
    // If the callback aborts PostgreSQL, preserve its error; rollback resets all.
    await tx.$queryRaw`SELECT set_config('grounding.github_owner', ${previous?.owner ?? ""}, true), set_config('grounding.github_repo', ${previous?.repo ?? ""}, true), set_config('grounding.github_task', ${previous?.task ?? ""}, true)`.catch((error: unknown) => {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2010" || error.meta?.code !== "25P02") throw error;
    });
  }
}
