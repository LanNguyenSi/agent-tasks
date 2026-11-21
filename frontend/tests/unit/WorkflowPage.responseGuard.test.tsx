/** @vitest-environment jsdom */
/**
 * The workflow editor checks every server response it puts into its
 * workflow state against the effective-workflow shape. A body that is not
 * one (the nightly-audit mock answers `{ ok: true }`) shows a danger banner
 * with a Retry that reloads the effective workflow, instead of the page
 * going blank on the missing definition; the previous workflow stays
 * loaded meanwhile. A valid body opens the editor as before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { EffectiveWorkflow, Project, User, WorkflowDefinition, WorkflowTemplateSummary } from "../../src/lib/api";

// A stable router object: the page's mount effect lists `router` in its
// deps, so a fresh object per render would re-run the first load and undo
// what a test is asserting about.
const navMocks = vi.hoisted(() => ({ router: { replace: vi.fn(), push: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => navMocks.router,
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
    customizeProjectWorkflow: vi.fn(),
    applyWorkflowTemplate: vi.fn(),
    resetProjectWorkflow: vi.fn(),
    updateWorkflow: vi.fn(),
  };
});

import WorkflowPage from "../../src/app/projects/[id]/workflow/page";
import {
  applyWorkflowTemplate,
  customizeProjectWorkflow,
  getCurrentUser,
  getEffectiveWorkflow,
  getProject,
  getWorkflowRules,
  listWorkflowTemplates,
  resetProjectWorkflow,
  updateWorkflow,
} from "../../src/lib/api";

const SHAPE_MESSAGE = "The server returned an unexpected workflow response";

const user = { id: "u-1", login: "lan", name: "Lan" } as User;

function baseDefinition(): WorkflowDefinition {
  return {
    initialState: "open",
    states: [
      { name: "open", label: "Open", terminal: false },
      { name: "in_progress", label: "In progress", terminal: false },
      { name: "done", label: "Done", terminal: true },
    ],
    transitions: [
      { from: "open", to: "in_progress", requiredRole: "any" },
      { from: "in_progress", to: "done", requiredRole: "any" },
    ],
  };
}

const TEMPLATE: WorkflowTemplateSummary = {
  slug: "lean",
  name: "Lean flow",
  description: "Two states, one edge.",
  stateCount: 2,
  initialState: "open",
};

function setup() {
  render(<WorkflowPage />);
}

beforeEach(() => {
  vi.clearAllMocks();
  const project = { id: "proj-1", teamId: "team-1", name: "p", canAdmin: true } as Project;
  vi.mocked(getCurrentUser).mockResolvedValue(user);
  vi.mocked(getProject).mockResolvedValue(project);
  vi.mocked(getWorkflowRules).mockResolvedValue([]);
  vi.mocked(listWorkflowTemplates).mockResolvedValue([TEMPLATE]);
  // The page opens on the system default workflow: that is where Customize
  // and the template picker live, so the malformed write answers below hit
  // a page that had a valid workflow loaded.
  vi.mocked(getEffectiveWorkflow).mockResolvedValue({
    source: "default",
    workflowId: null,
    definition: baseDefinition(),
  } as EffectiveWorkflow);
});
afterEach(cleanup);

async function ready() {
  await screen.findByRole("button", { name: /customize this workflow/i });
}

const malformed = { ok: true } as never;

describe("workflow page: a response that is not an effective workflow", () => {
  it("Customize answered {ok:true} shows the retry banner with the shape message, not a blank page", async () => {
    setup();
    await ready();
    vi.mocked(customizeProjectWorkflow).mockResolvedValue(malformed);
    fireEvent.click(screen.getByRole("button", { name: /customize this workflow/i }));

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(SHAPE_MESSAGE);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    // Not blank, and not the editor either: the state tables are gone.
    expect(screen.queryByRole("button", { name: /add state/i })).toBeNull();
  });

  it("Retry reloads the effective workflow and brings the editor back", async () => {
    setup();
    await ready();
    vi.mocked(customizeProjectWorkflow).mockResolvedValue(malformed);
    fireEvent.click(screen.getByRole("button", { name: /customize this workflow/i }));
    await screen.findByRole("alert");

    const custom: EffectiveWorkflow = { source: "custom", workflowId: "wf-2", definition: baseDefinition() };
    vi.mocked(getEffectiveWorkflow).mockResolvedValue(custom);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Custom workflow")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("apply-template answered {ok:true} shows the same banner", async () => {
    setup();
    await ready();
    vi.mocked(applyWorkflowTemplate).mockResolvedValue(malformed);
    fireEvent.click(screen.getByRole("button", { name: /lean flow/i }));

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(SHAPE_MESSAGE);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("a malformed first load shows the banner with the shape message", async () => {
    vi.mocked(getEffectiveWorkflow).mockResolvedValue(malformed);
    render(<WorkflowPage />);
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(SHAPE_MESSAGE);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("a Retry that answers a malformed body keeps the banner", async () => {
    setup();
    await ready();
    vi.mocked(customizeProjectWorkflow).mockResolvedValue(malformed);
    fireEvent.click(screen.getByRole("button", { name: /customize this workflow/i }));
    await screen.findByRole("alert");
    vi.mocked(getEffectiveWorkflow).mockResolvedValue(malformed);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(SHAPE_MESSAGE);
    expect(screen.queryByRole("button", { name: /add state/i })).toBeNull();
  });

  it("reset answered {ok:true} shows the banner with the shape message", async () => {
    vi.mocked(getEffectiveWorkflow).mockResolvedValue({
      source: "custom",
      workflowId: "wf-9",
      definition: baseDefinition(),
    } as EffectiveWorkflow);
    render(<WorkflowPage />);
    await screen.findByRole("button", { name: /reset to default/i });
    vi.mocked(resetProjectWorkflow).mockResolvedValue(malformed);
    fireEvent.click(screen.getByRole("button", { name: /reset to default/i }));
    fireEvent.click(await screen.findByRole("button", { name: /yes, reset/i }));

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(SHAPE_MESSAGE);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("a malformed post-save reload shows the banner and keeps the draft", async () => {
    vi.mocked(getEffectiveWorkflow).mockResolvedValue({
      source: "custom",
      workflowId: "wf-9",
      definition: baseDefinition(),
    } as EffectiveWorkflow);
    render(<WorkflowPage />);
    await screen.findByRole("button", { name: /add state/i });
    fireEvent.change(screen.getByRole("textbox", { name: "Label for state open" }), { target: { value: "Open!" } });
    vi.mocked(updateWorkflow).mockResolvedValue({} as never);
    vi.mocked(getEffectiveWorkflow).mockResolvedValueOnce(malformed);
    fireEvent.click(screen.getByRole("button", { name: /Save changes/ }));

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(SHAPE_MESSAGE);
  });

  it("Customize with a valid body opens the editor", async () => {
    setup();
    await ready();
    const custom: EffectiveWorkflow = { source: "custom", workflowId: "wf-2", definition: baseDefinition() };
    vi.mocked(customizeProjectWorkflow).mockResolvedValue(custom);
    fireEvent.click(screen.getByRole("button", { name: /customize this workflow/i }));

    expect(await screen.findByText("Custom workflow")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /add state/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
