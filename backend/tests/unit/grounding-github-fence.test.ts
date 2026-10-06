import { describe, it, expect } from "vitest";
import { isGithubFenceConflict } from "../../src/services/grounding-github-fence.js";

describe("isGithubFenceConflict", () => {
  it("is true for a Prisma-shaped error that names the fence trigger", () => {
    const err = Object.assign(new Error("Invalid `prisma.$executeRaw()` invocation"), {
      code: "P2010",
      meta: { code: "55000", message: "grounding_github_fence_conflict: acme/thing" },
    });
    expect(isGithubFenceConflict(err)).toBe(true);
  });

  it("is true when only the message names the fence trigger", () => {
    expect(isGithubFenceConflict({ message: "ERROR: grounding_github_fence_conflict: acme/thing" })).toBe(true);
  });

  it("is false for the other 55000 trigger refusal grounding_task_held", () => {
    const err = Object.assign(new Error("Invalid invocation"), { code: "P2010", meta: { code: "55000", message: "grounding_task_held" } });
    expect(isGithubFenceConflict(err)).toBe(false);
  });

  it("is false for a generic error, null, undefined and non-objects", () => {
    expect(isGithubFenceConflict(new Error("boom"))).toBe(false);
    expect(isGithubFenceConflict(null)).toBe(false);
    expect(isGithubFenceConflict(undefined)).toBe(false);
    expect(isGithubFenceConflict("grounding_github_fence_conflict")).toBe(false);
    expect(isGithubFenceConflict(42)).toBe(false);
  });
});
