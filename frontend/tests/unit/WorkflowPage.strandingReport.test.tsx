/** @vitest-environment jsdom */
/**
 * Workflow page: after a save, a template apply or a reset the 2xx body names
 * the tasks the change left on a status the workflow no longer has
 * (`terminalOutsideWorkflow`, `outsideWorkflow`, each cut at 50 with a
 * `...Truncated` flag). The page shows them once, as a warning under the Saved
 * banner, with the finished tasks and the other tasks on separate lines and an
 * "and more" line for a cut list. The next save, apply, reset or Cancel
 * clears it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  EffectiveWorkflow,
  Project,
  StrandingReport,
  User,
  WorkflowDefinition,
  WorkflowTemplateSummary,
} from "../../src/lib/api";

// One router object for every render: the page loads its data in an effect
// keyed on the router, so a fresh object per render would reload the workflow
// after each state change and undo a template apply or a reset.
const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
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
    applyWorkflowTemplate: vi.fn(),
    resetProjectWorkflow: vi.fn(),
  };
});

import WorkflowPage from "../../src/app/projects/[id]/workflow/page";
import {
  applyWorkflowTemplate,
  getCurrentUser,
  getEffectiveWorkflow,
  getProject,
  getWorkflowRules,
  listWorkflowTemplates,
  resetProjectWorkflow,
  updateWorkflow,
} from "../../src/lib/api";

const user = { id: "u-1", login: "lan", name: "Lan" } as User;
const TITLE = /keeps? a status this workflow no longer has/;

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

const TEMPLATE: WorkflowTemplateSummary = {
  slug: "tpl",
  name: "Template",
  description: "A template",
  stateCount: 4,
  initialState: "open",
};

function setup(source: "custom" | "default" = "custom") {
  const project = { id: "proj-1", teamId: "team-1", name: "p", canAdmin: true } as Project;
  const wf = {
    source,
    workflowId: source === "custom" ? "wf-1" : null,
    definition: baseDefinition(),
  } as EffectiveWorkflow;
  vi.mocked(getCurrentUser).mockResolvedValue(user);
  vi.mocked(getProject).mockResolvedValue(project);
  vi.mocked(getEffectiveWorkflow).mockResolvedValue(wf);
  vi.mocked(getWorkflowRules).mockResolvedValue([]);
  vi.mocked(listWorkflowTemplates).mockResolvedValue([TEMPLATE]);
  render(<WorkflowPage />);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const nameInput = (row: number) =>
  screen.getByRole("textbox", { name: `State name for row ${row}` }) as HTMLInputElement;
const select = (label: string) => screen.getByRole("combobox", { name: label }) as HTMLSelectElement;

/** Adds a connected `qa` state: a draft that validates and can be saved. */
async function editDraft() {
  await screen.findByRole("button", { name: /add state/i });
  await userEvent.click(screen.getByRole("button", { name: /add state/i }));
  fireEvent.change(nameInput(5), { target: { value: "qa" } });
  await userEvent.click(screen.getByRole("button", { name: /add transition/i }));
  fireEvent.change(select("From state for transition 4"), { target: { value: "in_progress" } });
  fireEvent.change(select("To state for transition 4"), { target: { value: "qa" } });
  await userEvent.click(screen.getByRole("button", { name: /add transition/i }));
  fireEvent.change(select("From state for transition 5"), { target: { value: "qa" } });
  fireEvent.change(select("To state for transition 5"), { target: { value: "review" } });
}

async function save(report: StrandingReport) {
  vi.mocked(updateWorkflow).mockResolvedValue({ workflow: {} as never, report });
  await userEvent.click(screen.getByRole("button", { name: /Save changes/ }));
}

const FINISHED = [
  { id: "task-aaa", status: "shipped" },
  { id: "task-bbb", status: "shipped" },
];
const LEGACY = [{ id: "task-ccc", status: "legacy_state" }];

function banner() {
  return screen.getByText(TITLE).closest("[role=alert]") as HTMLElement;
}

describe("workflow page: stranding report after a save", () => {
  it("shows both lists as a warning under the Saved banner, each task linked to its page", async () => {
    setup();
    await editDraft();
    await save({
      terminalOutsideWorkflow: FINISHED,
      terminalOutsideTruncated: false,
      outsideWorkflow: LEGACY,
      outsideTruncated: false,
    });
    await screen.findByText("Workflow changes have been persisted.");
    const box = banner();
    expect(within(box).getByText("3 tasks keep a status this workflow no longer has")).toBeInTheDocument();
    const finished = within(box).getByText("Finished tasks whose status was removed:").nextElementSibling as HTMLElement;
    const other = within(box).getByText("Tasks on a status the workflow does not have:").nextElementSibling as HTMLElement;
    expect(within(finished).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "shipped task-aaa",
      "shipped task-bbb",
    ]);
    expect(within(finished).getByRole("link", { name: "task-bbb" })).toHaveAttribute("href", "/tasks/task-bbb");
    expect(within(other).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["legacy_state task-ccc"]);
    expect(within(other).getByRole("link", { name: "task-ccc" })).toHaveAttribute("href", "/tasks/task-ccc");
    expect(within(box).queryByText("and more")).toBeNull();
  });

  it("says 'and more' under the cut finished list only when that list is truncated", async () => {
    setup();
    await editDraft();
    await save({
      terminalOutsideWorkflow: FINISHED,
      terminalOutsideTruncated: true,
      outsideWorkflow: LEGACY,
      outsideTruncated: false,
    });
    await screen.findByText(TITLE);
    const finished = screen.getByText("Finished tasks whose status was removed:").nextElementSibling as HTMLElement;
    const other = screen.getByText("Tasks on a status the workflow does not have:").nextElementSibling as HTMLElement;
    expect(within(finished).getByText("and more")).toBeInTheDocument();
    expect(within(other).queryByText("and more")).toBeNull();
    expect(screen.getByText("3+ tasks keep a status this workflow no longer has")).toBeInTheDocument();
  });

  it("says 'and more' under the other list only when that list is truncated", async () => {
    setup();
    await editDraft();
    await save({
      terminalOutsideWorkflow: FINISHED,
      terminalOutsideTruncated: false,
      outsideWorkflow: LEGACY,
      outsideTruncated: true,
    });
    await screen.findByText(TITLE);
    const finished = screen.getByText("Finished tasks whose status was removed:").nextElementSibling as HTMLElement;
    const other = screen.getByText("Tasks on a status the workflow does not have:").nextElementSibling as HTMLElement;
    expect(within(finished).queryByText("and more")).toBeNull();
    expect(within(other).getByText("and more")).toBeInTheDocument();
    expect(screen.getByText("3+ tasks keep a status this workflow no longer has")).toBeInTheDocument();
  });

  it("lists a single kind alone: no heading for the empty one", async () => {
    setup();
    await editDraft();
    await save({ terminalOutsideWorkflow: [], outsideWorkflow: LEGACY });
    await screen.findByText("1 task keeps a status this workflow no longer has");
    expect(screen.queryByText("Finished tasks whose status was removed:")).toBeNull();
    expect(screen.getByText("Tasks on a status the workflow does not have:")).toBeInTheDocument();
  });

  it.each([
    ["empty lists", { terminalOutsideWorkflow: [], terminalOutsideTruncated: false, outsideWorkflow: [], outsideTruncated: false }],
    ["no report fields", {}],
    ["truncated flags without tasks", { terminalOutsideTruncated: true, outsideTruncated: true }],
  ])("renders nothing for %s", async (_label, report) => {
    setup();
    await editDraft();
    await save(report);
    await screen.findByText("Workflow changes have been persisted.");
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it("disappears on the next successful save without a report", async () => {
    setup();
    await editDraft();
    await save({ terminalOutsideWorkflow: FINISHED, outsideWorkflow: LEGACY });
    await screen.findByText(TITLE);

    await editDraft();
    await save({});
    await screen.findByText("Workflow changes have been persisted.");
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it("disappears on a save whose response carries no report at all", async () => {
    setup();
    await editDraft();
    await save({ outsideWorkflow: LEGACY });
    await screen.findByText(TITLE);

    await editDraft();
    vi.mocked(updateWorkflow).mockResolvedValue({ workflow: {} as never } as never);
    await userEvent.click(screen.getByRole("button", { name: /Save changes/ }));
    await vi.waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
    expect(screen.getByText("Workflow changes have been persisted.")).toBeInTheDocument();
  });

  it("is replaced by the report of the next save", async () => {
    setup();
    await editDraft();
    await save({ terminalOutsideWorkflow: FINISHED, outsideWorkflow: LEGACY });
    await screen.findByText("3 tasks keep a status this workflow no longer has");

    await editDraft();
    await save({ outsideWorkflow: LEGACY });
    await screen.findByText("1 task keeps a status this workflow no longer has");
    expect(screen.queryByText("3 tasks keep a status this workflow no longer has")).toBeNull();
  });

  it("is cleared by Cancel", async () => {
    setup();
    await editDraft();
    await save({ outsideWorkflow: LEGACY });
    await screen.findByText(TITLE);

    await userEvent.click(screen.getByRole("button", { name: /add state/i }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(TITLE)).toBeNull();
  });
});

describe("workflow page: stranding report after a template apply or a reset", () => {
  it("shows the report of an applied template", async () => {
    setup("default");
    vi.mocked(applyWorkflowTemplate).mockResolvedValue({
      source: "custom",
      workflowId: "wf-2",
      definition: baseDefinition(),
      report: { terminalOutsideWorkflow: FINISHED, terminalOutsideTruncated: true, outsideWorkflow: [] },
    });
    await userEvent.click(await screen.findByRole("button", { name: /Template/ }));
    await screen.findByText("2+ tasks keep a status this workflow no longer has");
    expect(screen.getByRole("link", { name: "task-aaa" })).toHaveAttribute("href", "/tasks/task-aaa");
    expect(screen.queryByText("Workflow changes have been persisted.")).toBeNull();
  });

  it("shows the report of a reset", async () => {
    setup();
    vi.mocked(resetProjectWorkflow).mockResolvedValue({
      source: "default",
      workflowId: null,
      definition: baseDefinition(),
      report: { outsideWorkflow: LEGACY },
    });
    await userEvent.click(await screen.findByRole("button", { name: /Reset to default/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Yes, reset" }));
    await screen.findByText("1 task keeps a status this workflow no longer has");
    expect(screen.getByRole("link", { name: "task-ccc" })).toHaveAttribute("href", "/tasks/task-ccc");
  });

  it("a reset without a report clears the one a save showed", async () => {
    setup();
    await editDraft();
    await save({ outsideWorkflow: LEGACY });
    await screen.findByText(TITLE);

    vi.mocked(resetProjectWorkflow).mockResolvedValue({
      source: "default",
      workflowId: null,
      definition: baseDefinition(),
      report: {},
    });
    await userEvent.click(screen.getByRole("button", { name: /Reset to default/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Yes, reset" }));
    await screen.findByText(/This project inherits the built-in default workflow/);
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it("an applied template without a report clears the one a reset showed", async () => {
    setup();
    vi.mocked(resetProjectWorkflow).mockResolvedValue({
      source: "default",
      workflowId: null,
      definition: baseDefinition(),
      report: { outsideWorkflow: LEGACY },
    });
    await userEvent.click(await screen.findByRole("button", { name: /Reset to default/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Yes, reset" }));
    await screen.findByText(TITLE);

    vi.mocked(applyWorkflowTemplate).mockResolvedValue({
      source: "custom",
      workflowId: "wf-3",
      definition: baseDefinition(),
      report: {},
    });
    await userEvent.click(await screen.findByRole("button", { name: /Template/ }));
    await screen.findByText(/Edit states and gates below/);
    expect(screen.queryByText(TITLE)).toBeNull();
  });
});
