import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { assertGithubFenceInstalled, githubPrUrlMatches, isGithubFenceConflict, sameGithubPrUrl } from "../../src/services/grounding-github-fence.js";

it("requires the hold, migration enrollment and immutable command triggers alongside repository fences", async () => {
  const query = vi.fn().mockResolvedValue([{ count: 9n }]);
  const db = { $queryRaw: query } as unknown as Prisma.TransactionClient;
  await assertGithubFenceInstalled(db);
  expect(query.mock.calls[0][0].join("")).toContain("grounding_hold_task_guard");
  for (const count of [0n, 6n, 7n, 8n]) {
    query.mockResolvedValueOnce([{ count }]);
    await expect(assertGithubFenceInstalled(db)).rejects.toThrow(/not installed/);
  }
});

it.each([
  ["https://github.com/acme/repo/pull/42", "Acme/Repo", 42],
  ["https://github.com/Acme/Repo/pull/42", "acme/repo", 42],
  ["https://github.com/ACME/REPO/pull/42", "Acme/Repo", 42],
  ["https://github.com/acme/repo/pull/42", "acme/repo", 42],
] as const)("PR URL %s names %s pull %d regardless of owner/repo case", (url, repo, number) => {
  expect(githubPrUrlMatches(url, repo, number)).toBe(true);
});
it.each([
  ["different repository", "https://github.com/acme/other/pull/42", "acme/repo", 42],
  ["different owner", "https://github.com/evil/repo/pull/42", "acme/repo", 42],
  ["different number", "https://github.com/acme/repo/pull/43", "acme/repo", 42],
  ["number prefix", "https://github.com/acme/repo/pull/4", "acme/repo", 42],
  ["leading zero", "https://github.com/acme/repo/pull/042", "acme/repo", 42],
  ["uppercase host", "https://GITHUB.com/acme/repo/pull/42", "acme/repo", 42],
  ["other host", "https://github.example/acme/repo/pull/42", "acme/repo", 42],
  ["http scheme", "http://github.com/acme/repo/pull/42", "acme/repo", 42],
  ["trailing slash", "https://github.com/acme/repo/pull/42/", "acme/repo", 42],
  ["query suffix", "https://github.com/acme/repo/pull/42?tab=files", "acme/repo", 42],
  ["issues path", "https://github.com/acme/repo/issues/42", "acme/repo", 42],
  ["dot segment", "https://github.com/acme/../pull/42", "acme/..", 42],
  ["missing url", null, "acme/repo", 42],
  ["missing repo", "https://github.com/acme/repo/pull/42", null, 42],
  ["repo with leading space", "https://github.com/acme/repo/pull/42", " acme/repo", 42],
  ["repo with trailing space", "https://github.com/acme/repo/pull/42", "acme/repo ", 42],
  ["repo with trailing newline", "https://github.com/acme/repo/pull/42", "acme/repo\n", 42],
  ["missing number", "https://github.com/acme/repo/pull/42", "acme/repo", null],
] as const)("PR URL identity rejects %s", (_case, url, repo, number) => {
  expect(githubPrUrlMatches(url, repo, number)).toBe(false);
});
it("same PR URL compares canonical identities and keeps exact equality", () => {
  expect(sameGithubPrUrl("https://github.com/Acme/Repo/pull/42", "https://github.com/acme/repo/pull/42")).toBe(true);
  expect(sameGithubPrUrl("not a url", "not a url")).toBe(true);
  expect(sameGithubPrUrl("https://github.com/acme/repo/pull/42", "https://github.com/acme/repo/pull/43")).toBe(false);
  expect(sameGithubPrUrl("https://github.com/acme/repo/pull/42", "https://github.com/acme/other/pull/42")).toBe(false);
  expect(sameGithubPrUrl("https://github.com/acme/repo/pull/42", null)).toBe(false);
  expect(sameGithubPrUrl("https://github.com/acme/repo/pull/42/", "https://github.com/acme/repo/pull/42")).toBe(false);
});

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
