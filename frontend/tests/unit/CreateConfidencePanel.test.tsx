/** @vitest-environment jsdom */
/**
 * CreateConfidencePanel renders the backend's authoritative create-time
 * confidence after a task is created (task 1a925647): the server score vs the
 * project threshold, the missing fields (humanized), and the top nextActions.
 * It must surface the SERVER values verbatim, not recompute anything.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CreateConfidencePanel from "../../src/components/CreateConfidencePanel";
import type { CreateConfidence } from "../../src/lib/api";

afterEach(cleanup);

const base: CreateConfidence = {
  score: 62,
  threshold: 60,
  blocking: false,
  missing: ["goal", "acceptanceCriteria", "outOfScope"],
  findings: [],
  nextActions: [
    "Add a one-line Goal stating the intended outcome.",
    "Add 2-5 bullets describing observable completion conditions.",
  ],
};

const noop = () => {};

describe("CreateConfidencePanel", () => {
  it("renders the server score, humanized missing fields, and the nextActions", () => {
    render(<CreateConfidencePanel confidence={base} enforcementMode={null} status="open" onEdit={noop} onClose={noop} />);

    // the badge reads "Spec 62, complete" (named, no "/100").
    expect(screen.getByText(/^Spec 62, complete$/)).toBeInTheDocument();
    expect(screen.getByText(/At or above the 60 threshold/)).toBeInTheDocument();
    // camelCase keys are humanized and comma-joined.
    expect(screen.getByText(/Goal, Acceptance Criteria, Out Of Scope/)).toBeInTheDocument();
    for (const action of base.nextActions) {
      expect(screen.getByText(action)).toBeInTheDocument();
    }
  });

  it("warns when the task is below threshold or blocking", () => {
    render(
      <CreateConfidencePanel
        confidence={{ ...base, score: 40, blocking: true }}
        enforcementMode={null} status="open"
        onEdit={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByText(/Below the 60 threshold/)).toBeInTheDocument();
    expect(screen.queryByText(/At or above/)).not.toBeInTheDocument();
  });

  it("treats a keystone-blocking task as below threshold even when the score clears it", () => {
    render(
      <CreateConfidencePanel
        confidence={{ ...base, score: 80, blocking: true }}
        enforcementMode={null} status="open"
        onEdit={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByText(/Below the 60 threshold/)).toBeInTheDocument();
  });

  it("warns for a below-threshold score even when not blocking (isolates the score comparison)", () => {
    render(
      <CreateConfidencePanel
        confidence={{ ...base, score: 40, blocking: false }}
        enforcementMode={null} status="open"
        onEdit={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByText(/Below the 60 threshold/)).toBeInTheDocument();
    expect(screen.queryByText(/At or above/)).not.toBeInTheDocument();
  });

  // The badge and the verdict sentence sit side by side, so the badge must
  // tier against the SAME server threshold the sentence compares against.
  it("tiers the badge against the server threshold and names it in the tooltip", () => {
    render(
      <CreateConfidencePanel
        confidence={{ ...base, score: 70, threshold: 80 }}
        enforcementMode={null} status="open"
        onEdit={noop}
        onClose={noop}
      />,
    );
    // 70 vs the project threshold 80 (not the global default 60): partial.
    const badge = screen.getByText(/^Spec 70, partial$/);
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute("title", "How complete the task spec is (0-100). Project threshold: 80.");
    expect(screen.getByText(/At or above the 80 threshold|Below the 80 threshold/)).toBeInTheDocument();
  });

  it("reads the badge complete when the score clears the server threshold even below the global default", () => {
    render(
      <CreateConfidencePanel
        confidence={{ ...base, score: 40, threshold: 30 }}
        enforcementMode={null} status="open"
        onEdit={noop}
        onClose={noop}
      />,
    );
    // 40 vs 30: complete, though the global-default tier would say partial.
    expect(screen.getByText(/^Spec 40, complete$/)).toBeInTheDocument();
    expect(screen.getByText(/At or above the 30 threshold/)).toBeInTheDocument();
  });

  it("shows a self-assignment failure alongside the confidence", () => {
    render(
      <CreateConfidencePanel
        confidence={base}
        enforcementMode={null} status="open"
        assignmentError="Self-assignment failed: forbidden"
        onEdit={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Self-assignment failed: forbidden");
    // The confidence verdict still renders.
    expect(screen.getByText(/^Spec 62, complete$/)).toBeInTheDocument();
  });

  it("wires the Edit task and Close buttons", async () => {
    const onEdit = vi.fn();
    const onClose = vi.fn();
    render(
      <CreateConfidencePanel confidence={base} enforcementMode={null} status="open" onEdit={onEdit} onClose={onClose} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Edit task" }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("omits the missing line when nothing is missing", () => {
    render(
      <CreateConfidencePanel confidence={{ ...base, missing: [] }} enforcementMode={null} status="open" onEdit={noop} onClose={noop} />,
    );
    expect(screen.queryByText(/^Missing:/)).not.toBeInTheDocument();
  });

  // Review round 1 fix (task 31528564): a backlog task can't be claimed by
  // an agent at ANY confidence until an operator promotes it (backend
  // backlog_not_promoted); the panel's below-threshold "cannot claim" /
  // "advisory, can still claim" clauses are both false for it, so a
  // status-aware clause replaces them instead.
  it("shows the backlog claim clause instead of the pass/below-threshold copy, for a backlog task", () => {
    render(
      <CreateConfidencePanel confidence={base} enforcementMode={null} status="backlog" onEdit={noop} onClose={noop} />,
    );
    expect(
      screen.getByText(/Backlog: agents can claim this task only after it is promoted to Open\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/At or above/)).not.toBeInTheDocument();
    expect(screen.queryByText(/cannot claim this task/)).not.toBeInTheDocument();
    expect(screen.queryByText(/advisory in this project/)).not.toBeInTheDocument();
    // Backlog is neither pass nor fail: the verdict row stays color-neutral.
    const verdict = screen.getByText(/Backlog: agents can claim/).closest(".ccp-verdict-text");
    expect(verdict).not.toHaveClass("ccp-verdict-text--pass");
    expect(verdict).not.toHaveClass("ccp-verdict-text--fail");
  });

  it("shows the backlog claim clause even when the score is below threshold and BLOCK-enforced", () => {
    render(
      <CreateConfidencePanel
        confidence={{ ...base, score: 40, blocking: true }}
        enforcementMode="BLOCK"
        status="backlog"
        onEdit={noop}
        onClose={noop}
      />,
    );
    expect(
      screen.getByText(/Backlog: agents can claim this task only after it is promoted to Open\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/cannot claim this task/)).not.toBeInTheDocument();
  });

  it("does NOT show the backlog clause for a non-backlog (open) task", () => {
    render(
      <CreateConfidencePanel confidence={base} enforcementMode={null} status="open" onEdit={noop} onClose={noop} />,
    );
    expect(screen.queryByText(/Backlog: agents can claim/)).not.toBeInTheDocument();
    expect(screen.getByText(/At or above the 60 threshold/)).toBeInTheDocument();
  });

  it("omits the next-steps block when there are no nextActions", () => {
    render(
      <CreateConfidencePanel
        confidence={{ ...base, nextActions: [] }}
        enforcementMode={null} status="open"
        onEdit={noop}
        onClose={noop}
      />,
    );
    expect(screen.queryByText("Next steps to raise confidence")).not.toBeInTheDocument();
  });
});
