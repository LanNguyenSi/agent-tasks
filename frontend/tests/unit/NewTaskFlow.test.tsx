/** @vitest-environment jsdom */
/**
 * NewTaskFlow -- the /tasks in-place create flow.
 *
 * Contract under test:
 *   - multiple projects: step 1 renders a project picker; Continue stays
 *     disabled until a project is chosen; getProject is NOT called on open.
 *   - choosing a project + Continue loads it and hands off to NewTaskModal.
 *   - exactly one project: the picker step is skipped, the form opens
 *     directly with that project.
 *   - zero projects: empty state pointing to the dashboard, no Continue.
 *   - getProject failure: error banner, flow stays on step 1.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../src/lib/api", () => ({
  getProject: vi.fn(),
  createTask: vi.fn(),
  claimTask: vi.fn(),
}));

import NewTaskFlow from "../../src/components/tasks/NewTaskFlow";
import { ToastProvider } from "../../src/components/ui/Toast";
import { getProject } from "../../src/lib/api";

const mockGetProject = vi.mocked(getProject);

const PROJECTS = [
  { id: "p-1", name: "Alpha" },
  { id: "p-2", name: "Beta" },
];

function makeProject(id = "p-1", name = "Alpha") {
  return {
    id,
    teamId: "t-1",
    name,
    slug: name.toLowerCase(),
    description: null,
    githubRepo: null,
    githubSyncAt: null,
    taskTemplate: null,
    confidenceThreshold: 60,
    requireDistinctReviewer: false,
    soloMode: true,
    governanceMode: "AUTONOMOUS",
    notificationWebhookUrl: null,
    hasNotificationWebhookSecret: false,
    createdAt: new Date(0).toISOString(),
  } as Awaited<ReturnType<typeof getProject>>;
}

function renderFlow(projects = PROJECTS, props: Partial<Parameters<typeof NewTaskFlow>[0]> = {}) {
  return render(
    <ToastProvider>
      <NewTaskFlow
        open
        onClose={vi.fn()}
        projects={projects}
        onTaskCreated={vi.fn()}
        onEditTask={vi.fn()}
        {...props}
      />
    </ToastProvider>,
  );
}

beforeEach(() => {
  mockGetProject.mockReset();
  // jsdom does not implement scrollIntoView; the Select listbox calls it
  // to keep the active option visible.
  Element.prototype.scrollIntoView = vi.fn();
});

describe("NewTaskFlow", () => {
  it("renders the project picker for multiple projects without fetching", () => {
    renderFlow();
    expect(screen.getByText(/step 1 of 2/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(mockGetProject).not.toHaveBeenCalled();
  });

  it("loads the chosen project and hands off to the create form", async () => {
    mockGetProject.mockResolvedValue(makeProject("p-2", "Beta"));
    renderFlow();

    // The shared Select primitive renders as a combobox button + listbox.
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "Beta" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(mockGetProject).toHaveBeenCalledWith("p-2"));
    // NewTaskModal form is up: its pinned submit button exists.
    expect(await screen.findByRole("button", { name: "Create task" })).toBeInTheDocument();
  });

  it("skips the picker when only one project is accessible", async () => {
    mockGetProject.mockResolvedValue(makeProject());
    renderFlow([PROJECTS[0]!]);

    await waitFor(() => expect(mockGetProject).toHaveBeenCalledWith("p-1"));
    expect(await screen.findByRole("button", { name: "Create task" })).toBeInTheDocument();
    expect(screen.queryByText(/step 1 of 2/i)).not.toBeInTheDocument();
  });

  it("shows an empty state when there are no projects", () => {
    renderFlow([]);
    expect(screen.getByText("No projects yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to dashboard" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  });

  it("resets selection and step on reopen", async () => {
    mockGetProject.mockResolvedValue(makeProject("p-2", "Beta"));
    const { rerender } = renderFlow();

    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "Beta" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("button", { name: "Create task" })).toBeInTheDocument();

    rerender(
      <ToastProvider>
        <NewTaskFlow
          open={false}
          onClose={vi.fn()}
          projects={PROJECTS}
          onTaskCreated={vi.fn()}
          onEditTask={vi.fn()}
        />
      </ToastProvider>,
    );
    rerender(
      <ToastProvider>
        <NewTaskFlow
          open
          onClose={vi.fn()}
          projects={PROJECTS}
          onTaskCreated={vi.fn()}
          onEditTask={vi.fn()}
        />
      </ToastProvider>,
    );

    // Back on step 1 with a cleared selection, not the stale form.
    expect(screen.getByText(/step 1 of 2/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Create task" })).not.toBeInTheDocument();
  });

  it("drops a getProject resolution that lands after the flow was closed", async () => {
    let resolveLoad!: (p: ReturnType<typeof makeProject>) => void;
    mockGetProject.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const onClose = vi.fn();
    const { rerender } = renderFlow(PROJECTS, { onClose });

    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "Alpha" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    // Close while the request is in flight, then let it resolve.
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
    resolveLoad!(makeProject());

    rerender(
      <ToastProvider>
        <NewTaskFlow
          open
          onClose={onClose}
          projects={PROJECTS}
          onTaskCreated={vi.fn()}
          onEditTask={vi.fn()}
        />
      </ToastProvider>,
    );

    // The stale resolution must not have promoted the flow to step 2.
    expect(screen.getByText(/step 1 of 2/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create task" })).not.toBeInTheDocument();
  });

  it("surfaces a load failure and stays on the picker step", async () => {
    mockGetProject.mockRejectedValue(new Error("boom"));
    renderFlow();

    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "Alpha" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Failed to load project")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByText(/step 1 of 2/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create task" })).not.toBeInTheDocument();
  });
});
