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
  taskHref,
  safeBackHref,
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

describe("taskHref", () => {
  it("is the bare /tasks/<id> without a from (the pre-from template)", () => {
    expect(taskHref("t-1")).toBe("/tasks/t-1");
    expect(taskHref("t-1", {})).toBe("/tasks/t-1");
  });

  it("treats an empty from as absent", () => {
    expect(taskHref("t-1", { from: "" })).toBe("/tasks/t-1");
  });

  it("encodes the whole list URL into one from parameter", () => {
    expect(taskHref("t-1", { from: "/tasks?scope=open&q=a%20b" })).toBe(
      "/tasks/t-1?from=%2Ftasks%3Fscope%3Dopen%26q%3Da%2520b",
    );
  });

  it("round-trips through URLSearchParams and safeBackHref", () => {
    const from = "/tasks?scope=open&status=open%2Creview&q=a%20b";
    const query = taskHref("t-1", { from }).split("?")[1]!;
    expect(safeBackHref(new URLSearchParams(query).get("from"))).toBe(from);
  });
});

describe("safeBackHref", () => {
  it("accepts the bare list", () => {
    expect(safeBackHref("/tasks")).toBe("/tasks");
  });

  it("accepts the list with a query and returns it unchanged (no second decode)", () => {
    expect(safeBackHref("/tasks?scope=open&q=a%20b")).toBe("/tasks?scope=open&q=a%20b");
    expect(safeBackHref("/tasks?")).toBe("/tasks?");
  });

  // One row per rejected class. Each guard has an input only that guard
  // rejects, so removing a single guard fails exactly its row.
  it.each([
    ["regex: path traversal", "/tasks/../x"],
    ["regex: sub-path of /tasks", "/tasks/t-1"],
    ["regex: longer first segment", "/tasksfoo"],
    ["regex: another in-app path", "/dashboard"],
    ["regex: absolute https URL", "https://evil.com"],
    ["regex: javascript scheme", "javascript:alert(1)"],
    ["regex: protocol-relative", "//evil.com"],
    ["regex: slash-backslash", "/\\evil"],
    ["regex: fragment", "/tasks#x"],
    ["regex: fragment after query", "/tasks?a=b#x"],
    ["regex: encoded leading slash is not decoded into a match", "%2Ftasks"],
    ["regex: empty", ""],
    ["regex: leading space", " /tasks"],
    ["double slash in the query", "/tasks?next=//evil.com"],
    ["double slash only after decoding", "/tasks?next=%2F%2Fevil.com"],
    ["backslash in the query", "/tasks?next=\\evil"],
    ["backslash only after decoding", "/tasks?next=%5Cevil"],
    ["control character after decoding (CRLF)", "/tasks?q=%0D%0Ax"],
    ["control character after decoding (NUL)", "/tasks?q=%00"],
    ["control character after decoding (DEL)", "/tasks?q=%7F"],
    ["literal control character (tab)", "/tasks?q=a\tb"],
    ["literal control character (newline)", "/tasks?q=a\nb"],
    ["malformed percent-escape", "/tasks?q=%E0%A4%A"],
  ])("rejects %s", (_label, raw) => {
    expect(safeBackHref(raw)).toBeNull();
  });

  it("rejects non-string values: array-valued, null, undefined, number", () => {
    expect(safeBackHref(["/tasks"])).toBeNull();
    expect(safeBackHref(["/tasks", "//evil.com"])).toBeNull();
    expect(safeBackHref(null)).toBeNull();
    expect(safeBackHref(undefined)).toBeNull();
    expect(safeBackHref(42)).toBeNull();
  });
});
