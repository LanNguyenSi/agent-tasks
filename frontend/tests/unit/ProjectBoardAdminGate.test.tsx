/** @vitest-environment jsdom */
/**
 * Board task modal: the admin controls ("Change status…" in the More actions
 * menu) and the effective-workflow fetch behind them follow `canAdmin` from
 * GET /projects/:id when the server sent a boolean. A team member who also
 * holds PROJECT_ADMIN reports `accessRole: HUMAN_MEMBER`, so `accessRole`
 * alone would hide the controls; it decides only when `canAdmin` is absent
 * (older backend).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { User, Project, Task } from "../../src/lib/api";

const nav = vi.hoisted(() => ({ router: { replace: vi.fn(), push: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => nav.router,
  useParams: () => ({ id: "p-1" }),
  usePathname: () => "/projects/p-1/board",
  useSearchParams: () => new URLSearchParams(""),
  useSelectedLayoutSegment: () => "board",
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    getCurrentUser: vi.fn(),
    getTeams: vi.fn(),
    getProject: vi.fn(),
    getTasks: vi.fn(),
    getTask: vi.fn(),
    getEffectiveWorkflow: vi.fn(),
    getWorkflows: vi.fn(),
  };
});

import ProjectLayout from "../../src/app/projects/[id]/layout";
import ProjectBoardPage from "../../src/app/projects/[id]/board/page";
import { ToastProvider } from "../../src/components/ui/Toast";
import {
  getCurrentUser,
  getTeams,
  getProject,
  getTasks,
  getTask,
  getEffectiveWorkflow,
} from "../../src/lib/api";

const USER = { id: "u-1", login: "lan", name: "Lan" } as User;

const TASK = {
  id: "k-1",
  projectId: "p-1",
  title: "Gate task",
  status: "open",
  priority: "MEDIUM",
  labels: [],
  attachments: [],
  artifacts: [],
  comments: [],
  blockedBy: [],
  blocks: [],
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
} as unknown as Task;

function project(accessRole: string, canAdmin: boolean | undefined): Project {
  const p = {
    id: "p-1",
    teamId: "t-1",
    name: "Project One",
    slug: "project-one",
    githubRepo: null,
    governanceMode: "AUTONOMOUS",
    accessRole,
  } as unknown as Project;
  if (canAdmin !== undefined) p.canAdmin = canAdmin;
  return p;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue(USER);
  vi.mocked(getTeams).mockResolvedValue([]);
  vi.mocked(getTasks).mockResolvedValue([TASK]);
  vi.mocked(getTask).mockResolvedValue(TASK);
  vi.mocked(getEffectiveWorkflow).mockResolvedValue({
    source: "default",
    workflowId: null,
    definition: { initialState: "open", states: [], transitions: [{ from: "open", to: "done", requires: [] }] },
  } as never);
  window.localStorage.clear();
  window.history.replaceState({}, "", "/projects/p-1/board");
  Element.prototype.scrollIntoView = vi.fn();
});

const CASES: Array<[string, string, boolean | undefined, boolean]> = [
  ["canAdmin true, accessRole HUMAN_MEMBER", "HUMAN_MEMBER", true, true],
  ["canAdmin true, accessRole ADMIN", "ADMIN", true, true],
  ["canAdmin false, accessRole HUMAN_MEMBER", "HUMAN_MEMBER", false, false],
  ["canAdmin false, accessRole ADMIN (canAdmin wins)", "ADMIN", false, false],
  ["canAdmin absent, accessRole ADMIN (fallback)", "ADMIN", undefined, true],
  ["canAdmin absent, accessRole HUMAN_MEMBER (fallback)", "HUMAN_MEMBER", undefined, false],
];

describe("board task modal admin gate: canAdmin wins, accessRole is the fallback", () => {
  for (const [label, role, canAdmin, admin] of CASES) {
    it(`${label}: ${admin ? "Change status offered" : "Change status disabled"}`, async () => {
      vi.mocked(getProject).mockResolvedValue(project(role, canAdmin));
      render(
        <ToastProvider>
          <ProjectLayout>
            <ProjectBoardPage />
          </ProjectLayout>
        </ToastProvider>,
      );

      await userEvent.click(await screen.findByRole("button", { name: /Gate task/ }));
      await screen.findByRole("dialog");
      await userEvent.click(await screen.findByRole("button", { name: "More actions" }));

      if (admin) {
        expect(await screen.findByRole("button", { name: "Change status…" })).toBeEnabled();
        await waitFor(() => expect(getEffectiveWorkflow).toHaveBeenCalledWith("p-1"));
      } else {
        expect(await screen.findByRole("button", { name: /Change status \(admins only\)/ })).toBeDisabled();
        expect(screen.queryByRole("button", { name: "Change status…" })).not.toBeInTheDocument();
        expect(getEffectiveWorkflow).not.toHaveBeenCalled();
      }
    });
  }
});
