/** @vitest-environment jsdom */
/**
 * CreateConfidencePanel's below-threshold verdict copy — enforcement-mode-aware
 * (task e32cee5f, follow-up to a9dc7e58's TaskDetail badge fix).
 *
 * Before this fix the verdict always said "agents cannot claim this task"
 * once the score fell below the threshold, regardless of the project's
 * `enforcementMode`. That's only true when the project is in `BLOCK` mode —
 * a `WARN` or `OFF` project never actually blocks the claim server-side (see
 * backend lib/enforcement-mode.ts), so the old copy was restrictive-false:
 * harmless (nothing was actually blocked), but misleading to whoever read it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import CreateConfidencePanel from "../../src/components/CreateConfidencePanel";
import type { CreateConfidence } from "../../src/lib/api";

afterEach(cleanup);

const noop = () => {};

// score < threshold, blocking: false isolates the enforcementMode dimension
// from the score-independent keystone `blocking` flag.
const BELOW_THRESHOLD: CreateConfidence = {
  score: 40,
  threshold: 60,
  blocking: false,
  missing: [],
  findings: [],
  nextActions: [],
};

describe("CreateConfidencePanel — below-threshold verdict copy branches on the project's enforcementMode", () => {
  it("BLOCK: keeps the blocking wording", () => {
    render(
      <CreateConfidencePanel
        confidence={BELOW_THRESHOLD}
        enforcementMode="BLOCK" status="open"
        onEdit={noop}
        onClose={noop}
      />,
    );

    expect(screen.getByText(/agents cannot claim this task/)).toBeInTheDocument();
    expect(screen.queryByText(/advisory in this project/)).toBeNull();
  });

  it("WARN: uses advisory wording, not the blocking claim", () => {
    render(
      <CreateConfidencePanel
        confidence={BELOW_THRESHOLD}
        enforcementMode="WARN" status="open"
        onEdit={noop}
        onClose={noop}
      />,
    );

    expect(screen.getByText(/advisory in this project/)).toBeInTheDocument();
    expect(screen.queryByText(/agents cannot claim this task/)).toBeNull();
  });

  it("OFF: still surfaces the below-threshold verdict with advisory wording rather than hiding it", () => {
    render(
      <CreateConfidencePanel
        confidence={BELOW_THRESHOLD}
        enforcementMode="OFF" status="open"
        onEdit={noop}
        onClose={noop}
      />,
    );

    expect(screen.getByText(/advisory in this project/)).toBeInTheDocument();
    expect(screen.queryByText(/agents cannot claim this task/)).toBeNull();
  });

  it("runtime-undefined enforcementMode (older cached project data): defaults to advisory wording, matching the backend's own WARN default for an unset mode", () => {
    render(
      <CreateConfidencePanel
        confidence={BELOW_THRESHOLD}
        // The prop type is required (null at minimum), but stale caller data
        // can still deliver undefined at runtime; force it past the type to
        // pin that the render path degrades to the advisory wording either way.
        enforcementMode={undefined as unknown as null} status="open"
        onEdit={noop}
        onClose={noop}
      />,
    );

    expect(screen.getByText(/advisory in this project/)).toBeInTheDocument();
    expect(screen.queryByText(/agents cannot claim this task/)).toBeNull();
  });

  it("null enforcementMode (project row predates the column): same advisory default as undefined", () => {
    render(
      <CreateConfidencePanel
        confidence={BELOW_THRESHOLD}
        enforcementMode={null} status="open"
        onEdit={noop}
        onClose={noop}
      />,
    );

    expect(screen.getByText(/advisory in this project/)).toBeInTheDocument();
    expect(screen.queryByText(/agents cannot claim this task/)).toBeNull();
  });
});
