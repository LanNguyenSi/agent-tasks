/**
 * lib/routes.ts -- the single owner of in-app URLs (UI/IA stage 1).
 *
 * Every assertion here is an exact-string check: against the hand-built
 * template the builder replaced, or, for a route that has moved since
 * (the board, now a project hub tab), against its new URL. A route move
 * is the only way these tests may change. Parameter order and the omit-when-absent rule
 * are pinned per combination: each parameter alone, several together,
 * and none; an empty string counts as absent (the templates these
 * builders replaced used truthiness checks, e.g. TaskHeader's ternary).
 */
import { describe, it, expect } from "vitest";

import {
  boardHref,
  projectsHref,
  projectHubHref,
  settingsHref,
  apiTokensSettingsHref,
  ssoSettingsHref,
} from "../../src/lib/routes";

describe("boardHref", () => {
  it("is the legacy /dashboard (resumes the last board) when no parameter is given", () => {
    expect(boardHref()).toBe("/dashboard");
    expect(boardHref({})).toBe("/dashboard");
  });

  it("is the team's Projects page for teamId alone", () => {
    expect(boardHref({ teamId: "t1" })).toBe("/teams?teamId=t1");
  });

  it("is the project's board tab for projectId alone", () => {
    expect(boardHref({ projectId: "p1" })).toBe("/projects/p1/board");
  });

  it("drops a taskId that comes without its project", () => {
    expect(boardHref({ taskId: "k1" })).toBe("/dashboard");
  });

  it("leaves teamId out of the board URL", () => {
    expect(boardHref({ teamId: "t1", projectId: "p1" })).toBe("/projects/p1/board");
  });

  it("is the team's Projects page for teamId and taskId without a project", () => {
    expect(boardHref({ teamId: "t1", taskId: "k1" })).toBe("/teams?teamId=t1");
  });

  it("appends taskId to the project's board", () => {
    expect(boardHref({ projectId: "p1", taskId: "k1" })).toBe(
      "/projects/p1/board?taskId=k1",
    );
  });

  it("keeps only projectId and taskId when all three are given", () => {
    expect(boardHref({ teamId: "t1", projectId: "p1", taskId: "k1" })).toBe(
      "/projects/p1/board?taskId=k1",
    );
  });

  it("omits empty-string parameters (absent beats empty, as in the replaced ternaries)", () => {
    expect(boardHref({ teamId: "", projectId: "", taskId: "" })).toBe("/dashboard");
    expect(boardHref({ teamId: "t1", projectId: "", taskId: "k1" })).toBe("/teams?teamId=t1");
    expect(boardHref({ projectId: "p1", taskId: "" })).toBe("/projects/p1/board");
  });

  it("interpolates values raw without adding encoding", () => {
    expect(boardHref({ projectId: "p 1", taskId: "k 1" })).toBe(
      "/projects/p 1/board?taskId=k 1",
    );
  });
});

describe("projectsHref", () => {
  it("is a bare /teams when no team is selected", () => {
    expect(projectsHref()).toBe("/teams");
    expect(projectsHref({})).toBe("/teams");
  });

  it("appends the teamId query parameter when a team is selected", () => {
    expect(projectsHref({ teamId: "t1" })).toBe("/teams?teamId=t1");
  });

  it("omits an empty-string teamId (absent beats empty)", () => {
    expect(projectsHref({ teamId: "" })).toBe("/teams");
  });
});

describe("projectHubHref", () => {
  it("builds the members tab URL", () => {
    expect(projectHubHref("p1", "members")).toBe("/projects/p1/members");
  });

  it("builds the settings tab URL", () => {
    expect(projectHubHref("p1", "settings")).toBe("/projects/p1/settings");
  });

  it("builds the workflow tab URL", () => {
    expect(projectHubHref("p1", "workflow")).toBe("/projects/p1/workflow");
  });

  it("builds the board tab URL", () => {
    expect(projectHubHref("p1", "board")).toBe("/projects/p1/board");
  });

  it("is the hub root without a tab", () => {
    expect(projectHubHref("p1")).toBe("/projects/p1");
  });
});

describe("settings routes", () => {
  it("settingsHref is the settings root", () => {
    expect(settingsHref()).toBe("/settings");
  });

  it("apiTokensSettingsHref deep-links the API Tokens section", () => {
    expect(apiTokensSettingsHref()).toBe("/settings#api-tokens");
  });

  it("ssoSettingsHref is the SSO sub-page", () => {
    expect(ssoSettingsHref()).toBe("/settings/sso");
  });
});
