/**
 * /home dashboard widget filter predicates
 * (isBacklogTask, isPriorityTask, src/app/home/page.tsx).
 *
 * Contract:
 *   - isBacklogTask matches only status "backlog". This is the assertion
 *     the task's mutation probe (swapping the status the Backlog widget
 *     filters on) is expected to turn red.
 *   - isPriorityTask matches HIGH/CRITICAL priority tasks whose status is
 *     actionable (open, in_progress, review): done and abandoned tasks are
 *     finished, and backlog drafts aren't actionable until promoted (they
 *     surface in their own widget instead).
 */
import { describe, it, expect } from "vitest";
import {
  ACTIVE_STATUSES,
  ACTIVE_STATUS_PARAM,
  isActiveTask,
  isBacklogTask,
  isPriorityTask,
} from "../../src/app/home/widgetFilters";

describe("isBacklogTask", () => {
  it("matches a backlog-status task", () => {
    expect(isBacklogTask({ status: "backlog" })).toBe(true);
  });

  it("does not match open/review/done/in_progress", () => {
    expect(isBacklogTask({ status: "open" })).toBe(false);
    expect(isBacklogTask({ status: "in_progress" })).toBe(false);
    expect(isBacklogTask({ status: "review" })).toBe(false);
    expect(isBacklogTask({ status: "done" })).toBe(false);
  });
});

describe("isPriorityTask", () => {
  it("matches an open HIGH-priority task", () => {
    expect(isPriorityTask({ priority: "HIGH", status: "open" })).toBe(true);
  });

  it("matches an open CRITICAL-priority task", () => {
    expect(isPriorityTask({ priority: "CRITICAL", status: "in_progress" })).toBe(true);
  });

  it("excludes a done task even at CRITICAL priority", () => {
    expect(isPriorityTask({ priority: "CRITICAL", status: "done" })).toBe(false);
  });

  it("excludes a backlog task even at HIGH/CRITICAL priority (unpromoted drafts have their own widget)", () => {
    expect(isPriorityTask({ priority: "HIGH", status: "backlog" })).toBe(false);
    expect(isPriorityTask({ priority: "CRITICAL", status: "backlog" })).toBe(false);
  });

  it("excludes an abandoned task even at HIGH/CRITICAL priority", () => {
    expect(isPriorityTask({ priority: "HIGH", status: "abandoned" })).toBe(false);
    expect(isPriorityTask({ priority: "CRITICAL", status: "abandoned" })).toBe(false);
  });

  it("matches a HIGH-priority task in review", () => {
    expect(isPriorityTask({ priority: "HIGH", status: "review" })).toBe(true);
  });

  it("excludes a status outside the actionable set", () => {
    expect(isPriorityTask({ priority: "CRITICAL", status: "some_future_status" })).toBe(false);
  });

  it("excludes a MEDIUM/LOW priority task regardless of status", () => {
    expect(isPriorityTask({ priority: "MEDIUM", status: "open" })).toBe(false);
    expect(isPriorityTask({ priority: "LOW", status: "open" })).toBe(false);
  });
});

describe("isActiveTask (the one definition of active work)", () => {
  it("matches open and in_progress", () => {
    expect(isActiveTask({ status: "open" })).toBe(true);
    expect(isActiveTask({ status: "in_progress" })).toBe(true);
  });

  it("does not match review, backlog, done or abandoned", () => {
    expect(isActiveTask({ status: "review" })).toBe(false);
    expect(isActiveTask({ status: "backlog" })).toBe(false);
    expect(isActiveTask({ status: "done" })).toBe(false);
    expect(isActiveTask({ status: "abandoned" })).toBe(false);
  });

  it("builds the status request value from the same list", () => {
    expect(ACTIVE_STATUSES).toEqual(["open", "in_progress"]);
    expect(ACTIVE_STATUS_PARAM).toBe("open,in_progress");
  });
});
