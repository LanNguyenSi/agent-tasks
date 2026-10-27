import { describe, expect, it, vi } from "vitest";
vi.mock("../../src/services/github-delegation.js", () => ({ findDelegationUser: vi.fn() }));
import { groundingMergeConsent } from "../../src/services/grounding-merge-provider.js";
import { actor, ids } from "../helpers/grounding-fixtures.js";

describe("groundingMergeConsent refusal names its precondition", () => {
  it("names the absent github:pr_merge scope", async () => {
    await expect(groundingMergeConsent({} as never, { ...actor, scopes: [] }, ids.team)).rejects.toMatchObject({ code: "forbidden", status: 403, detail: "Token missing scope: github:pr_merge" });
  });
});
