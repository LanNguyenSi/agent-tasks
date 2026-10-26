/** @vitest-environment jsdom */
/**
 * NewTaskModal -- live header badge tiers against the project's EFFECTIVE
 * threshold (same layered resolver as TaskDetail), so the create form's badge
 * cannot read a different tier than the post-create panel and the task page.
 * Precedence: taskTypeThresholds[explicit taskType] -> confidenceThreshold ->
 * global default (unnamed in the tooltip when the caller knows nothing).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../src/lib/api", () => ({
  createTask: vi.fn(),
  claimTask: vi.fn(),
}));

import NewTaskModal from "../../src/components/dashboard/NewTaskModal";
import { ToastProvider } from "../../src/components/ui/Toast";

function renderModal(props: Partial<Parameters<typeof NewTaskModal>[0]> = {}) {
  return render(
    <ToastProvider>
      <NewTaskModal
        open
        onClose={vi.fn()}
        projectId="p-1"
        templateFields={{ goal: true, acceptanceCriteria: false, context: false, constraints: false }}
        templatePresets={[]}
        enforcementMode={null}
        onTaskCreated={vi.fn()}
        onEditTask={vi.fn()}
        {...props}
      />
    </ToastProvider>,
  );
}

function headerBadge(): HTMLElement | null {
  return document.querySelector(".confidence-badge");
}

// The Task type select lives inside the collapsed Agent Template section;
// open it before interacting (the header badge renders either way).
async function expandAgentTemplate() {
  await userEvent.click(screen.getByRole("button", { name: /Agent Template/ }));
}

beforeEach(() => {
  // jsdom does not implement scrollIntoView; the Select listbox calls it.
  Element.prototype.scrollIntoView = vi.fn();
});

describe("NewTaskModal -- live badge effective threshold", () => {
  it("names the project threshold in the tooltip when one is threaded", () => {
    renderModal({ confidenceThreshold: 80 });
    expect(headerBadge()).toHaveAttribute(
      "title",
      "How complete the task spec is (0-100). Project threshold: 80.",
    );
  });

  it("names no threshold when the caller threads none (global default fallback)", () => {
    renderModal();
    expect(headerBadge()).toHaveAttribute("title", "How complete the task spec is (0-100).");
  });

  it("the explicit taskType override beats the project threshold", async () => {
    renderModal({ confidenceThreshold: 50, taskTypeThresholds: { feature: 80 } });
    await expandAgentTemplate();
    await userEvent.click(screen.getByRole("combobox", { name: "Task type" }));
    await userEvent.click(screen.getByRole("option", { name: "feature" }));
    expect(headerBadge()).toHaveAttribute(
      "title",
      "How complete the task spec is (0-100). Project threshold: 80.",
    );
  });

  it("falls back to the project threshold once the taskType pick is cleared", async () => {
    renderModal({ confidenceThreshold: 50, taskTypeThresholds: { feature: 80 } });
    await expandAgentTemplate();
    const typeCombo = screen.getByRole("combobox", { name: "Task type" });
    await userEvent.click(typeCombo);
    await userEvent.click(screen.getByRole("option", { name: "feature" }));
    await userEvent.click(typeCombo);
    // The clear entry is the first option; its label is an em-dash string in
    // the component, so select it by position instead of by name.
    await userEvent.click(screen.getAllByRole("option")[0]!);
    expect(headerBadge()).toHaveAttribute(
      "title",
      "How complete the task spec is (0-100). Project threshold: 50.",
    );
  });
});
