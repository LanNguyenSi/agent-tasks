/**
 * blockerStatus -- helper to identify resolved blocker statuses
 * (mirrors backend RESOLVED_BLOCKER_STATUSES from backend/src/routes/tasks.ts)
 */
import { describe, it, expect } from "vitest";

import { isResolvedBlocker, RESOLVED_BLOCKER_STATUSES } from "./blockerStatus";

describe("blockerStatus", () => {
  describe("RESOLVED_BLOCKER_STATUSES", () => {
    it("includes done and abandoned", () => {
      expect(RESOLVED_BLOCKER_STATUSES).toContain("done");
      expect(RESOLVED_BLOCKER_STATUSES).toContain("abandoned");
    });

    it("includes exactly done and abandoned", () => {
      expect(RESOLVED_BLOCKER_STATUSES).toHaveLength(2);
    });
  });

  describe("isResolvedBlocker", () => {
    it("returns true for done status", () => {
      expect(isResolvedBlocker("done")).toBe(true);
    });

    it("returns true for abandoned status", () => {
      expect(isResolvedBlocker("abandoned")).toBe(true);
    });

    it("returns false for open status", () => {
      expect(isResolvedBlocker("open")).toBe(false);
    });

    it("returns false for in_progress status", () => {
      expect(isResolvedBlocker("in_progress")).toBe(false);
    });

    it("returns false for review status", () => {
      expect(isResolvedBlocker("review")).toBe(false);
    });

    it("returns false for unknown status", () => {
      expect(isResolvedBlocker("unknown")).toBe(false);
    });
  });
});
