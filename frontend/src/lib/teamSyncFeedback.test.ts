import { describe, expect, it } from "vitest";
import { teamSyncFeedback } from "./teamSyncFeedback";
import type { TeamSyncResult } from "./api";

const base: TeamSyncResult = {
  synced: 3,
  created: 0,
  updated: 0,
  pruned: 0,
  fenced: 0,
  pruneDeferred: false,
  skippedPrune: false,
  message: "m",
};

describe("teamSyncFeedback", () => {
  it("is success 'Already up to date' with nothing changed and nothing fenced", () => {
    expect(teamSyncFeedback(base)).toMatchObject({ tone: "success", title: "Already up to date" });
  });

  it("warns, never 'up to date', when every repo was fenced", () => {
    const f = teamSyncFeedback({ ...base, fenced: 3 });
    expect(f.tone).toBe("warning");
    expect(f.title).not.toBe("Already up to date");
    expect(f.message).toContain("3 repositories were skipped");
  });

  it("uses the singular for one fenced repo", () => {
    expect(teamSyncFeedback({ ...base, fenced: 1 }).message).toContain("1 repository was skipped");
  });

  it("warns when only the prune was deferred", () => {
    const f = teamSyncFeedback({ ...base, pruneDeferred: true });
    expect(f.tone).toBe("warning");
    expect(f.message).toContain("Removal of stale projects was postponed");
    expect(f.message).not.toContain("skipped");
  });

  it("names both fenced repos and the deferred prune together, with the counts", () => {
    const f = teamSyncFeedback({ ...base, created: 1, updated: 2, fenced: 2, pruneDeferred: true });
    expect(f.message).toContain("1 created, 2 updated, 0 pruned");
    expect(f.message).toContain("2 repositories were skipped");
    expect(f.message).toContain("postponed");
  });

  it("treats a response without fenced (older backend) as not fenced", () => {
    const { fenced: _f, pruneDeferred: _p, ...old } = base;
    expect(teamSyncFeedback(old as TeamSyncResult).title).toBe("Already up to date");
  });

  it("keeps the skippedPrune warning and the plain success summary", () => {
    expect(teamSyncFeedback({ ...base, skippedPrune: true, message: "zero" })).toEqual({
      tone: "warning",
      title: "Sync completed",
      message: "zero",
    });
    expect(teamSyncFeedback({ ...base, created: 2, pruned: 1 })).toMatchObject({
      tone: "success",
      title: "Sync completed",
      message: "2 created, 0 updated, 1 pruned.",
    });
  });

  // ── pruneSkipped / pruneRetained (each input combination is its own case) ──

  it("pruneSkipped alone never says 'Already up to date': 0/0/0 as a non-admin warns with the admin clause", () => {
    const f = teamSyncFeedback({ ...base, pruneSkipped: "not_admin" });
    expect(f.tone).toBe("warning");
    expect(f.title).not.toBe("Already up to date");
    expect(f.title).toBe("Sync completed");
    expect(f.message).toContain("0 created, 0 updated, 0 pruned");
    expect(f.message).toContain("Stale projects are only removed by a team admin.");
  });

  it("pruneSkipped alone with changed repos keeps the counts and adds the admin clause", () => {
    const f = teamSyncFeedback({ ...base, created: 1, updated: 2, pruneSkipped: "not_admin" });
    expect(f.tone).toBe("warning");
    expect(f.message).toContain("1 created, 2 updated, 0 pruned.");
    expect(f.message).toContain("Stale projects are only removed by a team admin.");
  });

  it("pruneSkipped null (a team admin's sync) changes nothing: 0/0/0 stays 'Already up to date'", () => {
    expect(teamSyncFeedback({ ...base, pruneSkipped: null })).toMatchObject({
      tone: "success",
      title: "Already up to date",
    });
  });

  it("pruneRetained alone warns with the kept count, singular", () => {
    const f = teamSyncFeedback({ ...base, pruneRetained: [{ projectId: "p1", reason: "grounding_history_retained" }] });
    expect(f.tone).toBe("warning");
    expect(f.title).not.toBe("Already up to date");
    expect(f.message).toContain("1 stale project was kept because of grounding history or a pending grounding operation.");
    expect(f.message).not.toContain("team admin");
    expect(f.message).not.toContain("p1");
  });

  it("pruneRetained alone pluralizes a count of two and stays a count, not a per-project list", () => {
    const f = teamSyncFeedback({
      ...base,
      pruned: 2,
      pruneRetained: [
        { projectId: "p1", reason: "grounding_history_retained" },
        { projectId: "p2", reason: "grounding_finalization_pending" },
      ],
    });
    expect(f.message).toContain("0 created, 0 updated, 2 pruned");
    expect(f.message).toContain("2 stale projects were kept");
    expect(f.message).not.toContain("p1");
  });

  it("pruneRetained and pruneSkipped together name both, the kept count first", () => {
    const f = teamSyncFeedback({
      ...base,
      pruneSkipped: "not_admin",
      pruneRetained: [{ projectId: "p1", reason: "grounding_finalization_pending" }],
    });
    expect(f.tone).toBe("warning");
    expect(f.message).toContain("1 stale project was kept because of grounding history or a pending grounding operation. Stale projects are only removed by a team admin.");
  });

  it("fenced wins the title, but a pruneSkipped notice still shows in the message", () => {
    const f = teamSyncFeedback({ ...base, fenced: 1, pruneSkipped: "not_admin" });
    expect(f.tone).toBe("warning");
    expect(f.title).toBe("Sync partly completed");
    expect(f.message).toContain("1 repository was skipped");
    expect(f.message).toContain("Stale projects are only removed by a team admin.");
    expect(f.message).toContain("Sync again shortly.");
  });

  it("fenced and pruneRetained together show both the fenced repo and the kept count", () => {
    const f = teamSyncFeedback({
      ...base,
      fenced: 2,
      pruneRetained: [{ projectId: "p1", reason: "grounding_history_retained" }],
    });
    expect(f.title).toBe("Sync partly completed");
    expect(f.message).toContain("2 repositories were skipped");
    expect(f.message).toContain("1 stale project was kept");
  });

  it("pruneDeferred and pruneSkipped together still warn as partly completed with both clauses", () => {
    const f = teamSyncFeedback({ ...base, pruneDeferred: true, pruneSkipped: "not_admin" });
    expect(f.title).toBe("Sync partly completed");
    expect(f.message).toContain("Removal of stale projects was postponed");
    expect(f.message).toContain("Stale projects are only removed by a team admin.");
  });

  it("skippedPrune wins over pruneSkipped: the backend's own message carries the admin clause", () => {
    const f = teamSyncFeedback({
      ...base,
      skippedPrune: true,
      pruneSkipped: "not_admin",
      message: "GitHub sync returned 0 repositories; prune was skipped for safety. Stale projects are only removed by a team admin.",
    });
    expect(f).toEqual({ tone: "warning", title: "Sync completed", message: "GitHub sync returned 0 repositories; prune was skipped for safety. Stale projects are only removed by a team admin." });
  });

  it("skippedPrune wins over pruneRetained too: the backend message already names the kept projects", () => {
    const f = teamSyncFeedback({
      ...base,
      skippedPrune: true,
      pruneRetained: [{ projectId: "p1", reason: "grounding_history_retained" }],
      message: "kept-once",
    });
    expect(f).toEqual({ tone: "warning", title: "Sync completed", message: "kept-once" });
  });

  it("treats a response without pruneSkipped/pruneRetained (older backend) as an admin sync with nothing retained", () => {
    const older = { ...base } as Partial<TeamSyncResult>;
    delete older.pruneSkipped;
    delete older.pruneRetained;
    expect(teamSyncFeedback(older as TeamSyncResult)).toMatchObject({
      tone: "success",
      title: "Already up to date",
    });
  });
});
