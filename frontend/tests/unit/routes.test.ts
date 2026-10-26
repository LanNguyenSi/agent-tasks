/**
 * lib/routes.ts -- the single owner of in-app URLs (UI/IA stage 1).
 *
 * Every assertion here is an exact-string check against the hand-built
 * template the builder replaced, so a future route move is the only way
 * these tests may change. Parameter order and the omit-when-absent rule
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
  it("is a bare /dashboard when no parameter is given", () => {
    expect(boardHref()).toBe("/dashboard");
    expect(boardHref({})).toBe("/dashboard");
  });

  it("emits teamId alone as the only query parameter", () => {
    expect(boardHref({ teamId: "t1" })).toBe("/dashboard?teamId=t1");
  });

  it("emits projectId alone without an empty teamId", () => {
    expect(boardHref({ projectId: "p1" })).toBe("/dashboard?projectId=p1");
  });

  it("emits taskId alone without an empty teamId/projectId", () => {
    expect(boardHref({ taskId: "k1" })).toBe("/dashboard?taskId=k1");
  });

  it("emits teamId and projectId in that order", () => {
    expect(boardHref({ teamId: "t1", projectId: "p1" })).toBe(
      "/dashboard?teamId=t1&projectId=p1",
    );
  });

  it("emits teamId and taskId, skipping an absent projectId", () => {
    expect(boardHref({ teamId: "t1", taskId: "k1" })).toBe(
      "/dashboard?teamId=t1&taskId=k1",
    );
  });

  it("emits projectId and taskId in that order, skipping an absent teamId", () => {
    expect(boardHref({ projectId: "p1", taskId: "k1" })).toBe(
      "/dashboard?projectId=p1&taskId=k1",
    );
  });

  it("emits all three parameters in teamId, projectId, taskId order", () => {
    expect(boardHref({ teamId: "t1", projectId: "p1", taskId: "k1" })).toBe(
      "/dashboard?teamId=t1&projectId=p1&taskId=k1",
    );
  });

  it("omits empty-string parameters (absent beats empty, as in the replaced ternaries)", () => {
    expect(boardHref({ teamId: "", projectId: "", taskId: "" })).toBe("/dashboard");
    expect(boardHref({ teamId: "t1", projectId: "", taskId: "k1" })).toBe(
      "/dashboard?teamId=t1&taskId=k1",
    );
  });

  it("interpolates values raw without adding encoding", () => {
    expect(boardHref({ teamId: "t 1" })).toBe("/dashboard?teamId=t 1");
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
