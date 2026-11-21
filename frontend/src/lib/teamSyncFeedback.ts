import type { TeamSyncResult } from "./api";

export interface TeamSyncFeedback {
  tone: "success" | "warning";
  title: string;
  message: string;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Picks the banner for a finished team sync. Warnings win over "up to date":
 * a sync that skipped repos because a repository operation was in flight, or that
 * postponed removing stale projects, did not finish its work.
 *
 * Precedence when several flags are set (each is its own test case):
 * 1. fenced / pruneDeferred (a repository operation is in flight): "Sync
 *    partly completed" wins; the prune notices below are appended to its
 *    warning list so nothing goes missing.
 * 2. skippedPrune (the GitHub list was empty, so pruning was skipped for
 *    safety): the backend's own message wins. No prune ran, so
 *    `pruneRetained` is empty, and for a non-admin the backend message
 *    already carries the admin clause, so composing it here again would
 *    duplicate it.
 * 3. pruneRetained non-empty or pruneSkipped === "not_admin": a warning
 *    naming the kept count and/or that stale projects are only removed by a
 *    team admin. This branch runs before "Already up to date", so a not-admin
 *    member's 0/0/0 sync is never presented as a fully finished sync.
 * 4. Otherwise the plain success branches.
 * Responses from an older backend (fields absent) keep the old behavior.
 */
export function teamSyncFeedback(result: TeamSyncResult): TeamSyncFeedback {
  const fenced = result.fenced ?? 0;
  const retained = result.pruneRetained ?? [];
  const notices: string[] = [];
  if (retained.length > 0) {
    notices.push(
      `${retained.length} stale ${plural(retained.length, "project was", "projects were")} kept because of grounding history or a pending grounding operation.`,
    );
  }
  if (result.pruneSkipped === "not_admin") {
    notices.push("Stale projects are only removed by a team admin.");
  }
  const warnings: string[] = [];
  if (fenced > 0) {
    warnings.push(
      `${fenced} ${plural(fenced, "repository was", "repositories were")} skipped because a repository operation is in flight for ${plural(fenced, "it", "them")}.`,
    );
  }
  if (result.pruneDeferred) {
    warnings.push("Removal of stale projects was postponed because a repository operation is in flight.");
  }
  if (warnings.length > 0) {
    return {
      tone: "warning",
      title: "Sync partly completed",
      message: `${result.created} created, ${result.updated} updated, ${result.pruned} pruned. ${warnings.concat(notices).join(" ")} Sync again shortly.`,
    };
  }
  if (result.skippedPrune) {
    return { tone: "warning", title: "Sync completed", message: result.message };
  }
  if (notices.length > 0) {
    return {
      tone: "warning",
      title: "Sync completed",
      message: `${result.created} created, ${result.updated} updated, ${result.pruned} pruned. ${notices.join(" ")}`,
    };
  }
  if (result.created === 0 && result.updated === 0 && result.pruned === 0) {
    return {
      tone: "success",
      title: "Already up to date",
      message: "No projects were created, updated, or pruned.",
    };
  }
  return {
    tone: "success",
    title: "Sync completed",
    message: `${result.created} created, ${result.updated} updated, ${result.pruned} pruned.`,
  };
}
