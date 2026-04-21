import { describe, expect, it } from "vitest";
import {
  GovernanceMode,
  deriveGovernanceModeFromFlags,
  resolveGovernanceMode,
  legacyFlagsFromGovernanceMode,
  governanceFlags,
} from "../../src/lib/governance-mode.js";

describe("deriveGovernanceModeFromFlags", () => {
  it("soloMode=true wins regardless of requireDistinctReviewer", () => {
    expect(
      deriveGovernanceModeFromFlags({ soloMode: true, requireDistinctReviewer: false }),
    ).toBe(GovernanceMode.AUTONOMOUS);
    // soloMode=true + requireDistinctReviewer=true is nonsensical but possible
    // in legacy rows; it was always a no-op in the gate, so we map to
    // AUTONOMOUS and move on.
    expect(
      deriveGovernanceModeFromFlags({ soloMode: true, requireDistinctReviewer: true }),
    ).toBe(GovernanceMode.AUTONOMOUS);
  });

  it("requireDistinctReviewer=true maps to REQUIRES_DISTINCT_REVIEWER", () => {
    expect(
      deriveGovernanceModeFromFlags({ soloMode: false, requireDistinctReviewer: true }),
    ).toBe(GovernanceMode.REQUIRES_DISTINCT_REVIEWER);
  });

  it("both flags false map to AWAITS_CONFIRMATION (async HITL)", () => {
    expect(
      deriveGovernanceModeFromFlags({ soloMode: false, requireDistinctReviewer: false }),
    ).toBe(GovernanceMode.AWAITS_CONFIRMATION);
  });
});

describe("resolveGovernanceMode", () => {
  it("prefers the explicit governanceMode column when set", () => {
    const project = {
      governanceMode: GovernanceMode.AWAITS_CONFIRMATION,
      // Legacy flags contradict — new column wins.
      soloMode: true,
      requireDistinctReviewer: true,
    };
    expect(resolveGovernanceMode(project)).toBe(GovernanceMode.AWAITS_CONFIRMATION);
  });

  it("falls back to legacy flags when governanceMode is null/missing", () => {
    expect(
      resolveGovernanceMode({
        governanceMode: null,
        soloMode: true,
        requireDistinctReviewer: false,
      }),
    ).toBe(GovernanceMode.AUTONOMOUS);
    expect(
      resolveGovernanceMode({
        soloMode: false,
        requireDistinctReviewer: true,
      }),
    ).toBe(GovernanceMode.REQUIRES_DISTINCT_REVIEWER);
    expect(resolveGovernanceMode({})).toBe(GovernanceMode.AWAITS_CONFIRMATION);
  });

  it("accepts governanceMode as a raw string (Prisma enum runtime shape)", () => {
    expect(
      resolveGovernanceMode({ governanceMode: "AUTONOMOUS" }),
    ).toBe(GovernanceMode.AUTONOMOUS);
  });

  it("falls back to legacy flags for an unknown governanceMode string (self-healing)", () => {
    expect(
      resolveGovernanceMode({
        governanceMode: "NOT_A_REAL_MODE",
        soloMode: true,
      }),
    ).toBe(GovernanceMode.AUTONOMOUS);
  });
});

describe("legacyFlagsFromGovernanceMode", () => {
  it("AUTONOMOUS → soloMode=true, requireDistinctReviewer=false", () => {
    expect(legacyFlagsFromGovernanceMode(GovernanceMode.AUTONOMOUS)).toEqual({
      soloMode: true,
      requireDistinctReviewer: false,
    });
  });
  it("REQUIRES_DISTINCT_REVIEWER → soloMode=false, requireDistinctReviewer=true", () => {
    expect(legacyFlagsFromGovernanceMode(GovernanceMode.REQUIRES_DISTINCT_REVIEWER)).toEqual({
      soloMode: false,
      requireDistinctReviewer: true,
    });
  });
  it("AWAITS_CONFIRMATION → both false", () => {
    expect(legacyFlagsFromGovernanceMode(GovernanceMode.AWAITS_CONFIRMATION)).toEqual({
      soloMode: false,
      requireDistinctReviewer: false,
    });
  });
  it("is the inverse of deriveGovernanceModeFromFlags on the canonical triples", () => {
    for (const mode of [
      GovernanceMode.AUTONOMOUS,
      GovernanceMode.AWAITS_CONFIRMATION,
      GovernanceMode.REQUIRES_DISTINCT_REVIEWER,
    ]) {
      expect(deriveGovernanceModeFromFlags(legacyFlagsFromGovernanceMode(mode))).toBe(mode);
    }
  });
});

describe("governanceFlags", () => {
  it("AUTONOMOUS: allowsSelfMerge=true, no notice", () => {
    expect(governanceFlags(GovernanceMode.AUTONOMOUS)).toEqual({
      allowsSelfMerge: true,
      requiresDistinctReviewer: false,
      emitsSelfMergeNotice: false,
    });
  });
  it("AWAITS_CONFIRMATION: allowsSelfMerge=true, emits notice", () => {
    expect(governanceFlags(GovernanceMode.AWAITS_CONFIRMATION)).toEqual({
      allowsSelfMerge: true,
      requiresDistinctReviewer: false,
      emitsSelfMergeNotice: true,
    });
  });
  it("REQUIRES_DISTINCT_REVIEWER: allowsSelfMerge=false, no notice", () => {
    expect(governanceFlags(GovernanceMode.REQUIRES_DISTINCT_REVIEWER)).toEqual({
      allowsSelfMerge: false,
      requiresDistinctReviewer: true,
      emitsSelfMergeNotice: false,
    });
  });
});
