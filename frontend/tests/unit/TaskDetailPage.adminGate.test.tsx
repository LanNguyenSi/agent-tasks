/** @vitest-environment jsdom */
/**
 * /tasks/[id]: the admin gate threaded into TaskDetail (`isProjectAdmin`) and
 * the effective-workflow fetch that only admins need. `canAdmin` from
 * GET /projects/:id wins when the server sent a boolean (a team member with a
 * PROJECT_ADMIN grant reports `accessRole: HUMAN_MEMBER`); `accessRole` decides
 * only when `canAdmin` is absent (older backend).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import type { Task, User, Team, Project } from "../../src/lib/api";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useParams: () => ({ id: "task-1" }),
  usePathname: () => "/tasks/task-1",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    getCurrentUser: vi.fn(),
    getTask: vi.fn(),
    getProject: vi.fn(),
    getTasks: vi.fn(),
    getTeams: vi.fn(),
    getEffectiveWorkflow: vi.fn(),
    getTaskConfidenceDetail: vi.fn(),
  };
});

vi.mock("../../src/components/TaskDetail", () => ({
  default: (props: { isProjectAdmin?: boolean }) => (
    <div className="td-page">admin:{String(props.isProjectAdmin)}</div>
  ),
}));

import TaskDetailPage from "../../src/app/tasks/[id]/page";
import {
  getCurrentUser,
  getTask,
  getProject,
  getTasks,
  getTeams,
  getEffectiveWorkflow,
  getTaskConfidenceDetail,
} from "../../src/lib/api";

const TASK = { id: "task-1", projectId: "proj-1", title: "A task" } as Task;

function project(accessRole: string | undefined, canAdmin: boolean | undefined): Project {
  const p = { id: "proj-1", teamId: "team-1", name: "Agent Tasks" } as Project;
  if (accessRole !== undefined) p.accessRole = accessRole;
  if (canAdmin !== undefined) p.canAdmin = canAdmin;
  return p;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", login: "lan" } as User);
  vi.mocked(getTask).mockResolvedValue(TASK);
  vi.mocked(getTasks).mockResolvedValue([TASK]);
  vi.mocked(getTeams).mockResolvedValue([{ id: "team-1", name: "Pandora" } as Team]);
  vi.mocked(getTaskConfidenceDetail).mockResolvedValue(null as never);
  vi.mocked(getEffectiveWorkflow).mockResolvedValue({
    source: "default",
    workflowId: null,
    definition: { initialState: "open", states: [], transitions: [{ from: "open", to: "done", requires: [] }] },
  } as never);
});

afterEach(cleanup);

const CASES: Array<[string, string, boolean | undefined, boolean]> = [
  ["canAdmin true, accessRole HUMAN_MEMBER", "HUMAN_MEMBER", true, true],
  ["canAdmin true, accessRole ADMIN", "ADMIN", true, true],
  ["canAdmin false, accessRole HUMAN_MEMBER", "HUMAN_MEMBER", false, false],
  ["canAdmin false, accessRole ADMIN (canAdmin wins)", "ADMIN", false, false],
  ["canAdmin absent, accessRole ADMIN (fallback)", "ADMIN", undefined, true],
  ["canAdmin absent, accessRole HUMAN_MEMBER (fallback)", "HUMAN_MEMBER", undefined, false],
];

describe("/tasks/[id] admin gate", () => {
  for (const [label, role, canAdmin, admin] of CASES) {
    it(`${label}: ${admin ? "admin controls on" : "admin controls off"}`, async () => {
      vi.mocked(getProject).mockResolvedValue(project(role, canAdmin));
      render(<TaskDetailPage />);
      await screen.findByText(`admin:${admin}`);
      // The workflow edges are fetched for admins only.
      if (admin) {
        await waitFor(() => expect(getEffectiveWorkflow).toHaveBeenCalledWith("proj-1"));
      } else {
        expect(getEffectiveWorkflow).not.toHaveBeenCalled();
      }
    });
  }
});
