/** @vitest-environment jsdom */
/**
 * DOM-backed tests for the localStorage side of the current-team helper:
 * the key round-trip (same key the Projects page switcher has always used,
 * `agent-tasks:lastTeamId`) and the blocked-storage paths — a throwing
 * getItem must behave exactly like absent storage (fall through to the
 * first team), and a throwing setItem must not crash the caller.
 *
 * Pattern mirrors src/lib/teamsPrefs.dom.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  LAST_TEAM_KEY,
  readRememberedTeamId,
  rememberTeam,
  resolveCurrentTeam,
} from "../../src/lib/currentTeam";

interface FakeTeam {
  id: string;
  name: string;
}

const t1: FakeTeam = { id: "t1", name: "Team One" };
const t2: FakeTeam = { id: "t2", name: "Team Two" };
const TEAMS = [t1, t2];

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  window.localStorage.clear();
});

describe("rememberTeam / readRememberedTeamId round-trip", () => {
  it("writes and reads the agent-tasks:lastTeamId key", () => {
    expect(readRememberedTeamId()).toBeNull();
    rememberTeam("t2");
    expect(window.localStorage.getItem(LAST_TEAM_KEY)).toBe("t2");
    expect(readRememberedTeamId()).toBe("t2");
  });
});

describe("resolveCurrentTeam with real storage", () => {
  it("stored only: the stored team beats teams[0]", () => {
    rememberTeam("t2");
    expect(resolveCurrentTeam(TEAMS, { urlTeamId: null })).toBe(t2);
  });

  it("both set and different: the URL team wins over the stored team", () => {
    rememberTeam("t1");
    expect(resolveCurrentTeam(TEAMS, { urlTeamId: "t2" })).toBe(t2);
  });

  it("an invalid stored id falls back to the first team", () => {
    window.localStorage.setItem(LAST_TEAM_KEY, "ghost");
    expect(resolveCurrentTeam(TEAMS, { urlTeamId: null })).toBe(t1);
  });
});

describe("blocked storage", () => {
  it("getItem throwing behaves as absent storage -> first team", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError: storage blocked");
    });
    expect(readRememberedTeamId()).toBeNull();
    expect(resolveCurrentTeam(TEAMS, { urlTeamId: null })).toBe(t1);
  });

  it("setItem throwing does not crash rememberTeam", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError: storage blocked");
    });
    expect(() => rememberTeam("t2")).not.toThrow();
  });

  it("getItem throwing does not defeat a valid URL team", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError: storage blocked");
    });
    expect(resolveCurrentTeam(TEAMS, { urlTeamId: "t2" })).toBe(t2);
  });
});
