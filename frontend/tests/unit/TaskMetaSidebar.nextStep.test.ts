import { describe, it, expect } from "vitest";
import { NEXT_STEP, nextStepSentence } from "../../src/components/task-detail/TaskMetaSidebar";

// Every status of the default workflow reads as a full sentence; none falls
// through to the custom-state wording.
const DEFAULT_WORKFLOW_STATUSES = ["backlog", "open", "in_progress", "review", "done"];

describe("workflow next-step sentences", () => {
  it.each(DEFAULT_WORKFLOW_STATUSES)("%s has its own full sentence", (status) => {
    expect(NEXT_STEP[status]).toBeDefined();
    const text = nextStepSentence(status);
    expect(text).toMatch(/^This task .+\.$/);
    expect(text).not.toMatch(/unknown/i);
    expect(text).not.toBe(nextStepSentence("custom_state"));
  });

  it("backlog says it is a draft to promote to Open", () => {
    expect(nextStepSentence("backlog")).toBe(
      "This task is a draft; promote it to Open to make it pickable.",
    );
  });

  it("a status outside the default workflow gets the neutral custom-state sentence, not 'unknown'", () => {
    expect(nextStepSentence("qa_signoff")).toBe("This task is in a custom workflow state.");
  });
});
