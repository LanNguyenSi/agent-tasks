/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { WorkflowDiagram } from "../../src/app/projects/[id]/workflow/_components/WorkflowDiagram";

afterEach(cleanup);

describe("WorkflowDiagram gate legend", () => {
  it("explains what the number next to an arrow counts", () => {
    render(
      <WorkflowDiagram
        def={{
          initialState: "open",
          states: [
            { name: "open", label: "Open", terminal: false },
            { name: "done", label: "Done", terminal: true },
          ],
          transitions: [{ from: "open", to: "done", requires: ["ciGreen"] }],
        } as never}
        onArrowClick={() => {}}
      />,
    );
    expect(screen.getByTestId("wf-gate-legend").textContent).toMatch(/number next to it is how many gates/);
  });
});
