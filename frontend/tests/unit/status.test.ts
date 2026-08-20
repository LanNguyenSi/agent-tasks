/**
 * lib/status.ts -- backlog status entry.
 *
 * Backlog is a first-class status (agent-created tasks start there): it
 * needs its own label/color pair, distinct from the "unknown status" grey
 * fallback StatusChip applies to anything not in STATUS_LABELS, and it must
 * be listed in KNOWN_STATUSES so callers can tell it apart from a truly
 * unrecognized workflow state.
 */
import { describe, it, expect } from "vitest";
import { STATUS_LABELS, STATUS_COLORS, KNOWN_STATUSES } from "../../src/lib/status";

describe("status.ts -- backlog", () => {
  it("has its own label", () => {
    expect(STATUS_LABELS.backlog).toBe("Backlog");
  });

  it("has its own dot/text color pair, distinct from open's", () => {
    expect(STATUS_COLORS.backlog).toEqual({
      dot: "var(--status-backlog)",
      text: "var(--status-backlog-text)",
    });
    expect(STATUS_COLORS.backlog).not.toEqual(STATUS_COLORS.open);
  });

  it("is listed in KNOWN_STATUSES", () => {
    expect(KNOWN_STATUSES).toContain("backlog");
  });
});
