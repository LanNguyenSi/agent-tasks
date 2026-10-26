/**
 * sectionHref (lib/teamSwitch.ts): the header's nav and brand targets. A team
 * id adds `?teamId=`; an absent, null or empty id leaves the bare section
 * root (absent beats empty, as in projectsHref).
 */
import { describe, it, expect } from "vitest";
import { sectionHref, teamSwitchHref } from "../../src/lib/teamSwitch";

describe("sectionHref", () => {
  it.each([
    ["home", "/home?teamId=t1"],
    ["projects", "/projects?teamId=t1"],
    ["tasks", "/tasks?teamId=t1"],
  ] as const)("%s with a team id is %s", (section, href) => {
    expect(sectionHref(section, "t1")).toBe(href);
  });

  it.each([
    ["home", "/home"],
    ["projects", "/projects"],
    ["tasks", "/tasks"],
  ] as const)("%s without a team id is the bare %s (absent, null and empty alike)", (section, href) => {
    expect(sectionHref(section)).toBe(href);
    expect(sectionHref(section, undefined)).toBe(href);
    expect(sectionHref(section, null)).toBe(href);
    expect(sectionHref(section, "")).toBe(href);
  });

  it("is what a team switch from that section navigates to", () => {
    expect(teamSwitchHref("/home", "t2")).toBe(sectionHref("home", "t2"));
    expect(teamSwitchHref("/projects/p1/board", "t2")).toBe(sectionHref("projects", "t2"));
    expect(teamSwitchHref("/tasks/x", "t2")).toBe(sectionHref("tasks", "t2"));
  });
});
