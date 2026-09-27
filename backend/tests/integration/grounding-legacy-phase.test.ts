import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completionActor as actor, completionFixture, completionStore } from "../helpers/grounding-completion-fixtures.js";

let store: Awaited<ReturnType<typeof completionStore>>;

beforeAll(async () => { store = await completionStore(); }, 60000);
afterAll(async () => { await store?.close(); });

describe("persisted legacy phase completion", () => {
  it("accepts pinned complete with ledger evidence", async () => {
    const fixture = await completionFixture(store, "LEGACY_LOCAL");
    await fixture.db.groundingCohort.update({ where: { taskId: fixture.taskId }, data: { legacyPhase: "complete" } });

    await expect(fixture.service.complete(fixture.taskId, actor, "complete", { action: "finish" }))
      .resolves.toMatchObject({ mode: "LEGACY_LOCAL", status: "review" });
    const after = await fixture.snapshot();
    expect(after.task).toMatchObject({ status: "review", claimedByAgentId: actor.tokenId });
    expect(after.operations).toHaveLength(1);
    expect(after.finalizations).toHaveLength(0);
    expect(after.audit).toHaveLength(1);
  });

  it.each([
    ["scope-resolution", 1],
    ["post-incident-review", 1],
    ["complete", 0],
  ])("rejects legacy phase %s without effects when ledger entries are %i", async (legacyPhase, entryCount) => {
    const fixture = await completionFixture(store, "LEGACY_LOCAL");
    await fixture.db.groundingCohort.update({ where: { taskId: fixture.taskId }, data: { legacyPhase } });
    fixture.ledger.getLedgerSummary.mockResolvedValue({ entryCount });
    const before = await fixture.snapshot();

    await expect(fixture.service.complete(fixture.taskId, actor, `reject-${legacyPhase}-${entryCount}`, { action: "finish" }))
      .rejects.toMatchObject({ code: "grounding_required" });
    expect(await fixture.snapshot()).toEqual(before);
    expect(fixture.deliverSignal).not.toHaveBeenCalled();
  });
});
