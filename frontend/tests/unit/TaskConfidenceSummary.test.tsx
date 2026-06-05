/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import TaskConfidenceSummary from "../../src/components/TaskConfidenceSummary";

describe("TaskConfidenceSummary", () => {
  it("shows the threshold warning and friendly missing-field labels", () => {
    render(
      <TaskConfidenceSummary
        score={48}
        threshold={60}
        missing={["description", "acceptanceCriteria", "constraints"]}
      />,
    );

    expect(screen.getByText("48%")).toBeInTheDocument();
    expect(screen.getByText(/Below threshold \(60\)/i)).toBeInTheDocument();
    expect(
      screen.getByText("Missing: Description, Acceptance criteria, Constraints"),
    ).toBeInTheDocument();
  });

  it("omits the warning copy when the score is above threshold", () => {
    render(
      <TaskConfidenceSummary
        score={88}
        threshold={60}
        missing={[]}
      />,
    );

    expect(screen.getByText("88%")).toBeInTheDocument();
    expect(screen.queryByText(/Below threshold/i)).toBeNull();
    expect(screen.queryByText(/^Missing:/i)).toBeNull();
  });
});
