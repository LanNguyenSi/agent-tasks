/**
 * Pure precedence matrix for the single current-team rule (T02).
 *
 * pickCurrentTeam takes both ids as inputs, so every combination is testable
 * in the node environment (no storage). resolveCurrentTeam layers the
 * localStorage read on top; in node `window` is undefined, which the helper
 * must treat as "nothing stored" (that combination is covered here too; the
 * storage-backed combinations live in currentTeam.dom.test.ts).
 *
 * Each case states which input wins.
 */
import { describe, it, expect } from "vitest";

import { pickCurrentTeam, resolveCurrentTeam } from "../../src/lib/currentTeam";

interface FakeTeam {
  id: string;
  name: string;
}

const t1: FakeTeam = { id: "t1", name: "Team One" };
const t2: FakeTeam = { id: "t2", name: "Team Two" };
const TEAMS = [t1, t2];

describe("pickCurrentTeam — precedence matrix", () => {
  it("URL only: the URL team wins over the first team", () => {
    expect(pickCurrentTeam(TEAMS, { urlTeamId: "t2", storedTeamId: null })).toBe(t2);
  });

  it("stored only: the stored team wins over the first team", () => {
    expect(pickCurrentTeam(TEAMS, { urlTeamId: null, storedTeamId: "t2" })).toBe(t2);
  });

  it("both set and different: the URL team wins over the stored team", () => {
    expect(pickCurrentTeam(TEAMS, { urlTeamId: "t1", storedTeamId: "t2" })).toBe(t1);
    expect(pickCurrentTeam(TEAMS, { urlTeamId: "t2", storedTeamId: "t1" })).toBe(t2);
  });

  it("URL invalid + stored valid: the stored team wins", () => {
    expect(pickCurrentTeam(TEAMS, { urlTeamId: "nope", storedTeamId: "t2" })).toBe(t2);
  });

  it("stored invalid + URL absent: the first team wins", () => {
    expect(pickCurrentTeam(TEAMS, { urlTeamId: null, storedTeamId: "nope" })).toBe(t1);
  });

  it("both invalid: the first team wins", () => {
    expect(pickCurrentTeam(TEAMS, { urlTeamId: "bad-url", storedTeamId: "bad-stored" })).toBe(t1);
  });

  it("no inputs at all: the first team wins", () => {
    expect(pickCurrentTeam(TEAMS, {})).toBe(t1);
  });

  it("empty teams: null regardless of the ids", () => {
    expect(pickCurrentTeam([], {})).toBeNull();
    expect(pickCurrentTeam([], { urlTeamId: "t1", storedTeamId: "t1" })).toBeNull();
  });
});

describe("resolveCurrentTeam — with absent storage (node: no window)", () => {
  it("treats the missing storage as absent: URL absent -> first team", () => {
    expect(resolveCurrentTeam(TEAMS, { urlTeamId: null })).toBe(t1);
  });

  it("URL team still wins when storage is absent", () => {
    expect(resolveCurrentTeam(TEAMS, { urlTeamId: "t2" })).toBe(t2);
  });

  it("an invalid URL team falls back to the first team", () => {
    expect(resolveCurrentTeam(TEAMS, { urlTeamId: "nope" })).toBe(t1);
  });

  it("empty teams -> null", () => {
    expect(resolveCurrentTeam([], { urlTeamId: "t1" })).toBeNull();
  });
});
