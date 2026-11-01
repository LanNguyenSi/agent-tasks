/** @vitest-environment jsdom */
/**
 * Workflow page: the states table is editable for project admins (add, rename,
 * remove, mark terminal) now that the backend accepts custom state names. The
 * draft rules mirror the backend (reserved names, pinned initial state, a
 * terminal state), a rename rewrites the transitions that referenced the old
 * name, and a server refusal on save is shown as the server worded it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { waitForCall } from "./helpers/waitForCall";
import type { EffectiveWorkflow, Project, User, WorkflowDefinition } from "../../src/lib/api";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useParams: () => ({ id: "proj-1" }),
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    getCurrentUser: vi.fn(),
    getProject: vi.fn(),
    getEffectiveWorkflow: vi.fn(),
    getWorkflowRules: vi.fn(),
    listWorkflowTemplates: vi.fn(),
    updateWorkflow: vi.fn(),
  };
});

import WorkflowPage from "../../src/app/projects/[id]/workflow/page";
import {
  ApiRequestError,
  getCurrentUser,
  getEffectiveWorkflow,
  getProject,
  getWorkflowRules,
  listWorkflowTemplates,
  updateWorkflow,
} from "../../src/lib/api";

const user = { id: "u-1", login: "lan", name: "Lan" } as User;

function baseDefinition(): WorkflowDefinition {
  return {
    initialState: "open",
    states: [
      { name: "open", label: "Open", terminal: false },
      { name: "in_progress", label: "In progress", terminal: false },
      { name: "review", label: "Review", terminal: false },
      { name: "done", label: "Done", terminal: true },
    ],
    transitions: [
      { from: "open", to: "in_progress", requiredRole: "any" },
      { from: "in_progress", to: "review", requiredRole: "any" },
      { from: "review", to: "done", requiredRole: "any" },
    ],
  };
}

function setup(opts: { definition?: WorkflowDefinition; canAdmin?: boolean } = {}) {
  const definition = opts.definition ?? baseDefinition();
  const project = { id: "proj-1", teamId: "team-1", name: "p", canAdmin: opts.canAdmin ?? true } as Project;
  const wf = { source: "custom", workflowId: "wf-1", definition } as EffectiveWorkflow;
  vi.mocked(getCurrentUser).mockResolvedValue(user);
  vi.mocked(getProject).mockResolvedValue(project);
  vi.mocked(getEffectiveWorkflow).mockResolvedValue(wf);
  vi.mocked(getWorkflowRules).mockResolvedValue([]);
  vi.mocked(listWorkflowTemplates).mockResolvedValue([]);
  render(<WorkflowPage />);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const nameInput = (row: number) =>
  screen.getByRole("textbox", { name: `State name for row ${row}` }) as HTMLInputElement;
const select = (label: string) => screen.getByRole("combobox", { name: label }) as HTMLSelectElement;
const rename = (row: number, value: string) => fireEvent.change(nameInput(row), { target: { value } });
const remove = (name: string) => userEvent.click(screen.getByTitle(`Remove state ${name}`));
const terminalBox = (name: string) =>
  screen.getByRole("checkbox", { name: `Mark state ${name} as terminal` }) as HTMLInputElement;

async function ready() {
  await screen.findByRole("button", { name: /add state/i });
}

describe("workflow page: who sees the state controls", () => {
  it("an admin gets Add state, name inputs, remove buttons and no lock notice", async () => {
    setup();
    await ready();
    expect(screen.queryByText(/cannot be added, renamed or removed/i)).toBeNull();
    expect(nameInput(2).value).toBe("in_progress");
    expect(screen.getAllByTitle(/^Remove state/)).toHaveLength(4);
    expect(terminalBox("done").checked).toBe(true);
  });

  it("a non-admin on a custom workflow sees the state list read-only", async () => {
    setup({ canAdmin: false });
    await screen.findByText(/Only project admins can edit\./);
    expect(screen.queryByRole("button", { name: /add state/i })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryAllByTitle(/^Remove state/)).toHaveLength(0);
    expect(screen.queryByText(/cannot be added, renamed or removed/i)).toBeNull();
  });
});

describe("workflow page: add a state", () => {
  it("appends a new_state_N row, focuses its name, marks the draft dirty and warns it is unconnected", async () => {
    setup();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /add state/i }));
    expect(nameInput(5).value).toBe("new_state_1");
    expect(nameInput(5)).toHaveFocus();
    expect(screen.getByText(/Custom workflow: unsaved changes/)).toBeInTheDocument();
    expect(screen.getByText(/"new_state_1" is unreachable from the initial state/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /add state/i }));
    expect(nameInput(6).value).toBe("new_state_2");
  });
});

describe("workflow page: rename", () => {
  it("rewrites the from and to of every transition that referenced the old name", async () => {
    setup();
    await ready();
    rename(3, "qa");
    expect(nameInput(3).value).toBe("qa");
    expect(select("To state for transition 2").value).toBe("qa");
    expect(select("From state for transition 3").value).toBe("qa");
    // untouched edges keep their ends
    expect(select("From state for transition 1").value).toBe("open");
    expect(select("To state for transition 3").value).toBe("done");
  });

  it("keeps following the row across several renames", async () => {
    setup();
    await ready();
    rename(3, "q");
    rename(3, "qa");
    rename(3, "qa_2");
    expect(select("To state for transition 2").value).toBe("qa_2");
    expect(select("From state for transition 3").value).toBe("qa_2");
  });

  it("an invalid name changes neither the draft nor the transitions", async () => {
    setup();
    await ready();
    rename(3, "Review Me");
    expect(screen.getByText(/must match \[a-z0-9_\]\+/)).toBeInTheDocument();
    expect(select("To state for transition 2").value).toBe("review");
    expect(screen.getByText("Custom workflow")).toBeInTheDocument();
  });

  it("a rename back to the original name leaves the draft clean", async () => {
    setup();
    await ready();
    rename(3, "qa");
    rename(3, "review");
    expect(screen.getByText("Custom workflow")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save changes/ })).toBeDisabled();
  });

  it("renaming a state that is the initial state moves initialState with it", async () => {
    const def: WorkflowDefinition = {
      initialState: "start",
      states: [
        { name: "start", label: "Start", terminal: false },
        { name: "done", label: "Done", terminal: true },
      ],
      transitions: [{ from: "start", to: "done", requiredRole: "any" }],
    };
    setup({ definition: def });
    await ready();
    fireEvent.change(screen.getByRole("textbox", { name: "Label for state start" }), { target: { value: "Start!" } });
    expect(screen.getByText(/initialState must be "open", got "start"/)).toBeTruthy();
    rename(1, "open");
    expect(screen.getByText("open", { selector: ".wf-initial-row code" })).toBeInTheDocument();
    expect(select("From state for transition 1").value).toBe("open");
    expect(screen.queryByText(/initialState must be/)).toBeNull();
  });
});

describe("workflow page: remove a state", () => {
  it("the initial state's remove button is disabled, so nothing changes", async () => {
    setup();
    await ready();
    expect(screen.getByTitle("Remove state open")).toBeDisabled();
    await remove("open");
    expect(screen.queryByText(/Cannot remove state "open"/)).toBeNull();
    expect(screen.getAllByTitle(/^Remove state/)).toHaveLength(4);
  });

  it("refuses the only terminal state", async () => {
    setup();
    await ready();
    await remove("done");
    expect(screen.getByText(/Cannot remove state "done": it is the only terminal state/)).toBeInTheDocument();
    expect(screen.getAllByTitle(/^Remove state/)).toHaveLength(4);
  });

  it("with a second terminal state the last-terminal refusal no longer applies (the transitions check does)", async () => {
    setup();
    await ready();
    await userEvent.click(terminalBox("review"));
    await userEvent.click(screen.getByTitle("Remove state done"));
    expect(screen.queryByText(/only terminal state/)).toBeNull();
    expect(screen.getByText(/Cannot remove state "done": 1 transition\(s\) still reference it/)).toBeInTheDocument();
  });

  it("refuses a state that transitions still reference, with guidance", async () => {
    setup();
    await ready();
    await remove("review");
    expect(
      screen.getByText(/Cannot remove state "review": 2 transition\(s\) still reference it\. Remove those transitions first\./),
    ).toBeInTheDocument();
    expect(screen.getAllByTitle(/^Remove state/)).toHaveLength(4);
  });

  it("removes an unconnected state and the draft is clean again", async () => {
    setup();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /add state/i }));
    expect(screen.getAllByTitle(/^Remove state/)).toHaveLength(5);
    await remove("new_state_1");
    expect(screen.getAllByTitle(/^Remove state/)).toHaveLength(4);
    expect(screen.getByText("Custom workflow")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save changes/ })).toBeDisabled();
  });

  it("keeps an expanded instructions row on the state it was opened for", async () => {
    setup();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /add state/i }));
    await userEvent.click(screen.getByRole("button", { name: /add state/i }));
    // expand instructions of the second new state (index 5), then remove the first (index 4)
    const expandButtons = screen.getAllByRole("button", { name: /Add instructions/ });
    await userEvent.click(expandButtons[expandButtons.length - 1]!);
    expect(screen.getByRole("textbox", { name: "Agent instructions for state new_state_2" })).toBeInTheDocument();
    await remove("new_state_1");
    expect(screen.getByRole("textbox", { name: "Agent instructions for state new_state_2" })).toBeInTheDocument();
  });

  it("keeps an expanded row open when a row after it is removed", async () => {
    setup();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /add state/i }));
    await userEvent.click(screen.getByRole("button", { name: /add state/i }));
    const expandButtons = screen.getAllByRole("button", { name: /Add instructions/ });
    await userEvent.click(expandButtons[expandButtons.length - 2]!);
    expect(screen.getByRole("textbox", { name: "Agent instructions for state new_state_1" })).toBeInTheDocument();
    await remove("new_state_2");
    expect(screen.getByRole("textbox", { name: "Agent instructions for state new_state_1" })).toBeInTheDocument();
  });

  it("does not open another row's instructions when a lower row is removed", async () => {
    setup();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /add state/i }));
    await userEvent.click(screen.getByRole("button", { name: /add state/i }));
    // expand the first new state (index 4), then remove it: nothing may stay expanded
    const expandButtons = screen.getAllByRole("button", { name: /Add instructions/ });
    await userEvent.click(expandButtons[expandButtons.length - 2]!);
    expect(screen.getByRole("textbox", { name: "Agent instructions for state new_state_1" })).toBeInTheDocument();
    await remove("new_state_1");
    expect(screen.queryByRole("textbox", { name: /Agent instructions for state/ })).toBeNull();
  });
});

describe("workflow page: terminal toggle", () => {
  it("refuses to unmark the last terminal state", async () => {
    setup();
    await ready();
    await userEvent.click(terminalBox("done"));
    expect(
      screen.getByText(/Cannot unmark "done" as terminal: the workflow needs at least one terminal state/),
    ).toBeInTheDocument();
    expect(terminalBox("done").checked).toBe(true);
  });

  it("the initial state's terminal checkbox is disabled, so it stays non-terminal", async () => {
    setup();
    await ready();
    expect(terminalBox("open")).toBeDisabled();
    await userEvent.click(terminalBox("open"));
    expect(terminalBox("open").checked).toBe(false);
    expect(screen.queryByText(/Cannot mark "open" as terminal/)).toBeNull();
    expect(screen.getByText("Custom workflow")).toBeInTheDocument();
  });

  it("marks a second terminal state and then lets the first be unmarked", async () => {
    setup();
    await ready();
    await userEvent.click(terminalBox("review"));
    expect(terminalBox("review").checked).toBe(true);
    await userEvent.click(terminalBox("done"));
    expect(terminalBox("done").checked).toBe(false);
    expect(screen.queryByText(/Cannot unmark/)).toBeNull();
  });
});

describe("workflow page: backend rules in the validation banner", () => {
  async function dirty() {
    await ready();
    const label = screen.getByRole("textbox", { name: "Label for state open" });
    fireEvent.change(label, { target: { value: "Open!" } });
  }

  it("a reserved state name is an error and blocks Save", async () => {
    const def = baseDefinition();
    def.states.push({ name: "backlog", label: "Backlog", terminal: false });
    setup({ definition: def });
    await dirty();
    expect(screen.getByText(/"backlog" is reserved/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save changes/ })).toBeDisabled();
  });

  it("a transition to a reserved state is an error", async () => {
    const def = baseDefinition();
    def.transitions.push({ from: "review", to: "abandoned", requiredRole: "any" });
    setup({ definition: def });
    await dirty();
    expect(screen.getByText(/Transition to reserved state "abandoned"/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save changes/ })).toBeDisabled();
  });

  it("an initial state other than open is an error", async () => {
    const def = baseDefinition();
    def.initialState = "in_progress";
    setup({ definition: def });
    await dirty();
    expect(screen.getByText(/initialState must be "open", got "in_progress"/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save changes/ })).toBeDisabled();
  });

  it("a terminal initial state is an error", async () => {
    const def = baseDefinition();
    def.states[0]!.terminal = true;
    setup({ definition: def });
    await dirty();
    expect(screen.getByText(/Initial state "open" must not be a terminal state/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save changes/ })).toBeDisabled();
  });

  it("a definition without a terminal state is an error", async () => {
    const def = baseDefinition();
    def.states[3]!.terminal = false;
    setup({ definition: def });
    await dirty();
    expect(screen.getByText("The workflow needs at least one terminal state.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save changes/ })).toBeDisabled();
  });

  it("a clean custom-state definition has no errors", async () => {
    setup();
    await dirty();
    expect(screen.queryByText(/Validation errors/)).toBeNull();
    expect(screen.getByRole("button", { name: /Save changes/ })).toBeEnabled();
  });
});

describe("workflow page: create a custom state, connect it, save", () => {
  async function buildQaState() {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /add state/i }));
    rename(5, "qa");
    await userEvent.click(screen.getByRole("button", { name: /add transition/i }));
    fireEvent.change(select("From state for transition 4"), { target: { value: "in_progress" } });
    fireEvent.change(select("To state for transition 4"), { target: { value: "qa" } });
    await userEvent.click(screen.getByRole("button", { name: /add transition/i }));
    fireEvent.change(select("From state for transition 5"), { target: { value: "qa" } });
    fireEvent.change(select("To state for transition 5"), { target: { value: "review" } });
  }

  it("saves the full draft with the custom state and its edges", async () => {
    setup();
    await buildQaState();
    vi.mocked(updateWorkflow).mockResolvedValue({} as never);
    await userEvent.click(screen.getByRole("button", { name: /Save changes/ }));
    const calls = await waitForCall(vi.mocked(updateWorkflow));
    expect(calls).toHaveLength(1);
    const [id, body] = calls[0]!;
    expect(id).toBe("wf-1");
    const def = body.definition!;
    expect(def.initialState).toBe("open");
    expect(def.states.map((s) => s.name)).toEqual(["open", "in_progress", "review", "done", "qa"]);
    expect(def.transitions.map((t) => `${t.from}>${t.to}`)).toEqual([
      "open>in_progress",
      "in_progress>review",
      "review>done",
      "in_progress>qa",
      "qa>review",
    ]);
    await screen.findByText("Workflow changes have been persisted.");
  });

  it("shows a 409 answer from the server as it came and keeps the draft", async () => {
    setup();
    await buildQaState();
    const message =
      "Workflow not saved: 2 task(s) are in a state the new definition does not have (review). Move them first.";
    vi.mocked(updateWorkflow).mockRejectedValue(new ApiRequestError("stranded_tasks", message, 409));
    await userEvent.click(screen.getByRole("button", { name: /Save changes/ }));
    const banner = await screen.findByText(message);
    expect(within(banner.closest("[role=alert]") as HTMLElement).getByText("Error")).toBeInTheDocument();
    expect(nameInput(5).value).toBe("qa");
    expect(screen.getByRole("button", { name: /Save changes/ })).toBeEnabled();
  });

  it("shows a validation answer from the server as it came", async () => {
    setup();
    await buildQaState();
    const message = "State name must match [a-z0-9_]+";
    vi.mocked(updateWorkflow).mockRejectedValue(new ApiRequestError("request_failed", message, 400));
    await userEvent.click(screen.getByRole("button", { name: /Save changes/ }));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });
});
