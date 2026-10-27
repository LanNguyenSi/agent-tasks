import { describe, expect, it, vi } from "vitest";
vi.mock("../../src/services/github-delegation.js", () => ({ findDelegationUser: vi.fn() }));
import { findDelegationUser } from "../../src/services/github-delegation.js";
import { groundingMergeConsent } from "../../src/services/grounding-merge-provider.js";
import { actor, ids } from "../helpers/grounding-fixtures.js";

describe("groundingMergeConsent refusal names its precondition", () => {
  it("names the absent github:pr_merge scope", async () => {
    await expect(groundingMergeConsent({} as never, { ...actor, scopes: [] }, ids.team)).rejects.toMatchObject({ code: "forbidden", status: 403, detail: "Token missing scope: github:pr_merge" });
  });
  it("names the missing team member consent when no member allows agent PR merges", async () => {
    vi.mocked(findDelegationUser).mockResolvedValue(null);
    await expect(groundingMergeConsent({} as never, { ...actor, scopes: ["github:pr_merge"] }, ids.team)).rejects.toMatchObject({ code: "forbidden", status: 403, detail: "No team member allows agent PR merges (allowAgentPrMerge)" });
    vi.mocked(findDelegationUser).mockReset();
  });
});
