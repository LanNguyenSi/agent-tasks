import { describe, it, expect } from "vitest";
import { githubRepoEqualsInsensitive } from "../../src/lib/github-repo-match.js";

describe("githubRepoEqualsInsensitive", () => {
  it("returns an insensitive equals filter", () => {
    expect(githubRepoEqualsInsensitive("acme/repo")).toEqual({ equals: "acme/repo", mode: "insensitive" });
  });
  it("escapes the underscore wildcard", () => {
    expect(githubRepoEqualsInsensitive("acme/my_repo").equals).toBe("acme/my\\_repo");
  });
  it("escapes the percent wildcard", () => {
    expect(githubRepoEqualsInsensitive("acme/50%").equals).toBe("acme/50\\%");
  });
  it("escapes the backslash itself", () => {
    expect(githubRepoEqualsInsensitive("acme/a\\b").equals).toBe("acme/a\\\\b");
  });
  it("leaves hyphen, dot and slash untouched", () => {
    expect(githubRepoEqualsInsensitive("Acme-Co/my.repo-1").equals).toBe("Acme-Co/my.repo-1");
  });
});
