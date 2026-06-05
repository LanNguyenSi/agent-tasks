/**
 * Unit tests for `backend/src/lib/enforcement-mode.ts` (scorer-v2 T5).
 */
import { describe, it, expect } from "vitest";
import {
  EnforcementMode,
  DEFAULT_ENFORCEMENT_MODE,
  resolveEnforcementMode,
  enforcementBlocks,
} from "../../src/lib/enforcement-mode.js";

describe("resolveEnforcementMode", () => {
  it("defaults to WARN for null/undefined (the rollout default)", () => {
    expect(resolveEnforcementMode({ enforcementMode: null })).toBe(EnforcementMode.WARN);
    expect(resolveEnforcementMode({ enforcementMode: undefined })).toBe(EnforcementMode.WARN);
    expect(resolveEnforcementMode({})).toBe(EnforcementMode.WARN);
    expect(DEFAULT_ENFORCEMENT_MODE).toBe(EnforcementMode.WARN);
  });

  it("returns the explicit column value when set", () => {
    expect(resolveEnforcementMode({ enforcementMode: "OFF" })).toBe(EnforcementMode.OFF);
    expect(resolveEnforcementMode({ enforcementMode: "WARN" })).toBe(EnforcementMode.WARN);
    expect(resolveEnforcementMode({ enforcementMode: "BLOCK" })).toBe(EnforcementMode.BLOCK);
    expect(resolveEnforcementMode({ enforcementMode: EnforcementMode.BLOCK })).toBe(EnforcementMode.BLOCK);
  });

  it("falls back to WARN for an unrecognised value rather than throwing (self-healing)", () => {
    expect(resolveEnforcementMode({ enforcementMode: "NONSENSE" })).toBe(EnforcementMode.WARN);
  });
});

describe("enforcementBlocks", () => {
  it("is true only for BLOCK", () => {
    expect(enforcementBlocks(EnforcementMode.BLOCK)).toBe(true);
    expect(enforcementBlocks(EnforcementMode.WARN)).toBe(false);
    expect(enforcementBlocks(EnforcementMode.OFF)).toBe(false);
  });
});
