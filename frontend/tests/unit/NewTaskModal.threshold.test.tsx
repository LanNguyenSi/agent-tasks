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

  // The call-site guard (NewTaskModal, header badge) reads:
  //   confidenceThreshold === null && taskTypeThresholds === null
  //     ? null  (badge falls back to the global default 60, tooltip unnamed)
  //     : resolveEffectiveThreshold(picked taskType, taskTypeThresholds,
  //         confidenceThreshold)  (override -> project -> global 60, named).
  // Pinned per input combination; the winning input is named in each name.

  it("override alone (no project threshold, matching taskType pick): the taskType override wins", async () => {
    renderModal({ taskTypeThresholds: { feature: 80 } });
    await expandAgentTemplate();
    await userEvent.click(screen.getByRole("combobox", { name: "Task type" }));
    await userEvent.click(screen.getByRole("option", { name: "feature" }));
    expect(headerBadge()).toHaveAttribute(
      "title",
      "How complete the task spec is (0-100). Project threshold: 80.",
    );
  });

  it("empty override map with no project threshold: global default 60 is named (unlike the both-absent case above, which omits the sentence)", () => {
    // Absent (null/omitted) vs empty ({}): the guard only checks `=== null`,
    // so an empty map reaches the resolver, which resolves the global
    // default and the badge NAMES "Project threshold: 60" where the
    // nothing-threaded case above keeps the tooltip silent.
    renderModal({ confidenceThreshold: null, taskTypeThresholds: {} });
    expect(headerBadge()).toHaveAttribute(
      "title",
      "How complete the task spec is (0-100). Project threshold: 60.",
    );
  });

  it("override map present but no taskType picked and no project threshold: global default 60 wins", () => {
    renderModal({ confidenceThreshold: null, taskTypeThresholds: { feature: 80 } });
    expect(headerBadge()).toHaveAttribute(
      "title",
      "How complete the task spec is (0-100). Project threshold: 60.",
    );
  });

  it("empty override map with a project threshold: the project threshold still wins over the global default", () => {
    renderModal({ confidenceThreshold: 40, taskTypeThresholds: {} });
    expect(headerBadge()).toHaveAttribute(
      "title",
      "How complete the task spec is (0-100). Project threshold: 40.",
    );
  });

  it("all three present (project threshold, matching override, typed pick): the taskType override wins over the project threshold", async () => {
    renderModal({ confidenceThreshold: 40, taskTypeThresholds: { feature: 80 } });
    await expandAgentTemplate();
    await userEvent.click(screen.getByRole("combobox", { name: "Task type" }));
    await userEvent.click(screen.getByRole("option", { name: "feature" }));
    expect(headerBadge()).toHaveAttribute(
      "title",
      "How complete the task spec is (0-100). Project threshold: 80.",
    );
  });

  it("override map present but keyed to another taskType: the project threshold wins", async () => {
    renderModal({ confidenceThreshold: 40, taskTypeThresholds: { security: 80 } });
    await expandAgentTemplate();
    await userEvent.click(screen.getByRole("combobox", { name: "Task type" }));
    await userEvent.click(screen.getByRole("option", { name: "feature" }));
    expect(headerBadge()).toHaveAttribute(
      "title",
      "How complete the task spec is (0-100). Project threshold: 40.",
    );
  });
});
