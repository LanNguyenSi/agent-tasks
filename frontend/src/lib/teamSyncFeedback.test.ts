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
});
