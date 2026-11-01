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
 */
export function teamSyncFeedback(result: TeamSyncResult): TeamSyncFeedback {
  const fenced = result.fenced ?? 0;
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
      message: `${result.created} created, ${result.updated} updated, ${result.pruned} pruned. ${warnings.join(" ")} Sync again shortly.`,
    };
  }
  if (result.skippedPrune) {
    return { tone: "warning", title: "Sync completed", message: result.message };
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
