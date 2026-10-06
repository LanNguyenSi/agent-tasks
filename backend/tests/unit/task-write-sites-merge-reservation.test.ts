/**
 * Class guard for the merge reservation (agent-tasks eb08742f): every write to
 * the `tasks` table in the backend source either carries the reservation
 * predicate (`noLiveMergeReservation`, or `taskStatusCasWhere`, which includes
 * it) or is listed below with the reason it is allowed to ignore a live merge
 * reservation. A new writer of claims or status that does neither fails here,
 * so the decision is made when the writer is added and not found in review.
 *
 * The scan is textual on purpose: it cannot prove a predicate is right (the
 * DB-backed suite in tests/integration/merge-reservation.test.ts does that per
 * writer); it only keeps the list of write sites closed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const squash = (text: string) => text.replace(/\s+/g, " ");

interface Site {
  file: string;
  line: number;
  call: string;
}

/** Every `<client>.task.update|updateMany|upsert|delete|deleteMany(...)` call in src. */
function prismaTaskWrites(): Site[] {
  const sites: Site[] = [];
  const pattern = /\.task\.(update|updateMany|upsert|delete|deleteMany)\(/g;
  for (const path of sourceFiles(SRC)) {
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(pattern)) {
      let depth = 1;
      let end = match.index! + match[0].length;
      while (depth > 0 && end < text.length) {
        if (text[end] === "(") depth += 1;
        if (text[end] === ")") depth -= 1;
        end += 1;
      }
      sites.push({
        file: relative(SRC, path),
        line: text.slice(0, match.index).split("\n").length,
        call: squash(text.slice(match.index!, end)),
      });
    }
  }
  return sites;
}

/** Every raw `UPDATE tasks` statement in src. */
function rawTaskUpdates(): Site[] {
  const sites: Site[] = [];
  const pattern = /UPDATE\s+"?tasks"?\s[\s\S]*?(?:`|$)/g;
  for (const path of sourceFiles(SRC)) {
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(pattern)) {
      sites.push({
        file: relative(SRC, path),
        line: text.slice(0, match.index).split("\n").length,
        call: squash(match[0]),
      });
    }
  }
  return sites;
}

const GUARD = /noLiveMergeReservation|taskStatusCasWhere/;

/**
 * Writers that ignore a live merge reservation on purpose. `snippet` must occur
 * in the (whitespace-normalized) call; each entry must match at least one site.
 */
const ALLOWED_WITHOUT_PREDICATE: Array<{ file: string; snippet: string; count: number; reason: string }> = [
  { file: "routes/github.ts", snippet: "data: { branchName: body.head, prUrl: pr.html_url", count: 1, reason: "records the PR the agent just created: branch and PR fields only, no claim or status" },
  { file: "routes/workflows.ts", snippet: "data: { workflowId: null }", count: 1, reason: "detaches a deleted workflow from tasks: no claim or status" },
  { file: "routes/tasks.ts", snippet: "data: { metadata: flavor.mergedMetadata", count: 2, reason: "stores the derived debug flavor on pickup/start: metadata only" },
  { file: "routes/tasks.ts", snippet: "data: { branchName, prUrl, prNumber }", count: 1, reason: "task_submit_pr: branch and PR fields only" },
  { file: "routes/tasks.ts", snippet: "...(body.branchName !== undefined ? { branchName: body.branchName }", count: 1, reason: "agent PATCH: branch, PR and result fields only (status and claims are not writable there)" },
  { file: "routes/tasks.ts", snippet: "data: patchData, include: taskInclude })", count: 1, reason: "human PATCH without a status: the status lane above carries the predicate, this branch never writes status or claims" },
  { file: "routes/tasks.ts", snippet: "status: { in: [\"open\", \"backlog\"] }, claimedByUserId: null", count: 1, reason: "task_respec: edits the description of an open or backlog, unclaimed task; no claim or status change" },
  { file: "routes/tasks.ts", snippet: ".task.delete({ where: { id: task.id } })", count: 1, reason: "human DELETE of a task: removes the row; a merge in flight then answers merged_but_status_changed with no current status" },
  { file: "routes/tasks.ts", snippet: "blockedBy: { connect:", count: 1, reason: "dependency edge: no claim or status" },
  { file: "routes/tasks.ts", snippet: "blockedBy: { disconnect:", count: 1, reason: "dependency edge: no claim or status" },
  { file: "services/grounding-github-create.ts", snippet: "data: { branchName: request.head, prUrl: frozen.url", count: 1, reason: "grounded PR creation: branch and PR fields only" },
  { file: "services/github-webhook.ts", snippet: "data: { status: target", count: 1, reason: "GitHub webhook (issue closed, PR merged, review): records a fact that already happened on GitHub and must land; its race with a merge is the merge_webhook_first path of the post-merge write" },
  { file: "services/github-webhook.ts", snippet: "data: updates })", count: 1, reason: "GitHub webhook: PR link fields synced from the event" },
  { file: "services/grounding-direct-mutations.ts", snippet: "data, include: groundingRouteTaskInclude", count: 1, reason: "grounded direct edits of task fields (title, description, PR fields, labels): status and claims are not writable there" },
  { file: "services/grounding-github-observation-context.ts", snippet: "where: { id: task.id, status: task.status, prNumber: task.prNumber", count: 1, reason: "Grounding webhook observation: records GitHub facts like the legacy webhook writers" },
];

/** Raw task UPDATEs: the reservation's own bookkeeping and the fence's no-op touches. */
const ALLOWED_RAW = [
  { file: "services/task-status-cas.ts", snippet: "SET \"mergeReservedByUserId\"", reason: "takes the reservation (its own conditional write)" },
  { file: "services/task-merge-reservation.ts", snippet: "SET \"mergeReservedByUserId\" = NULL", reason: "releases the reservation" },
  { file: "services/grounding-github-fence.ts", snippet: "SET \"updatedAt\" = \"updatedAt\"", reason: "serialization touch, changes no column" },
  { file: "services/grounding-migration.ts", snippet: "SET \"updatedAt\" = \"updatedAt\"", reason: "serialization touch, changes no column" },
];

describe("every write to the tasks table carries the merge-reservation predicate or is listed with a reason", () => {
  const writes = prismaTaskWrites();

  it("finds the writers (the scan is not vacuous)", () => {
    expect(writes.length).toBeGreaterThan(25);
    expect(writes.filter((site) => GUARD.test(site.call)).length).toBeGreaterThan(15);
  });

  it("no unguarded write is missing from the allowlist", () => {
    const unlisted = writes
      .filter((site) => !GUARD.test(site.call))
      .filter((site) => !ALLOWED_WITHOUT_PREDICATE.some((entry) => entry.file === site.file && site.call.includes(entry.snippet)))
      .map((site) => `${site.file}:${site.line}  ${site.call.slice(0, 140)}`);
    expect(unlisted, "add the merge-reservation predicate to the write, or list it with the reason it may ignore a live reservation").toEqual([]);
  });

  it.each(ALLOWED_WITHOUT_PREDICATE)("the allowlist entry for $file ($snippet) matches exactly $count write(s): no stale or widened entry", (entry) => {
    const matched = writes.filter((site) => !GUARD.test(site.call) && site.file === entry.file && site.call.includes(entry.snippet));
    expect(matched).toHaveLength(entry.count);
  });

  it("raw UPDATE statements on tasks are the reservation's own or the fence's no-op touches", () => {
    const raw = rawTaskUpdates();
    expect(raw.length).toBeGreaterThanOrEqual(ALLOWED_RAW.length);
    const unlisted = raw
      .filter((site) => !ALLOWED_RAW.some((entry) => entry.file === site.file && site.call.includes(entry.snippet)))
      .map((site) => `${site.file}:${site.line}  ${site.call.slice(0, 140)}`);
    expect(unlisted).toEqual([]);
    for (const entry of ALLOWED_RAW) {
      expect(raw.some((site) => site.file === entry.file && site.call.includes(entry.snippet)), `${entry.file}: ${entry.reason}`).toBe(true);
    }
  });
});
