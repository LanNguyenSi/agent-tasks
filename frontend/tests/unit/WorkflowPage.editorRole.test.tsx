/** @vitest-environment jsdom */
/**
 * Workflow page: who may edit. The backend gates every workflow write on
 * team ADMIN or per-project PROJECT_ADMIN, which GET /projects/:id reports as
 * `canAdmin` (the team role wins `accessRole`, so a team member who also holds
 * PROJECT_ADMIN reports `HUMAN_MEMBER` there). The page gates on `canAdmin`
 * when the server sent it and on `accessRole` otherwise (older backend); the
 * team list is not consulted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { EffectiveWorkflow, Project, User } from "../../src/lib/api";

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
  };
});

import WorkflowPage from "../../src/app/projects/[id]/workflow/page";
import {
  getCurrentUser,
  getEffectiveWorkflow,
  getProject,
  getWorkflowRules,
  listWorkflowTemplates,
} from "../../src/lib/api";

const user = { id: "u-1", login: "lan", name: "Lan" } as User;

function workflow(source: "custom" | "default"): EffectiveWorkflow {
  return {
    source,
    workflowId: source === "custom" ? "wf-1" : null,
    definition: {
      initialState: "open",
      states: [
        { name: "open", label: "Open", terminal: false },
        { name: "done", label: "Done", terminal: true },
      ],
      transitions: [{ from: "open", to: "done", requires: [] }],
    },
  } as EffectiveWorkflow;
}

function setup(
  source: "custom" | "default",
  accessRole: string | null | undefined,
  canAdmin?: boolean,
) {
  const project = { id: "proj-1", teamId: "team-1", name: "p" } as Project;
  if (accessRole !== undefined) project.accessRole = accessRole;
  if (canAdmin !== undefined) project.canAdmin = canAdmin;
  vi.mocked(getCurrentUser).mockResolvedValue(user);
  vi.mocked(getProject).mockResolvedValue(project);
  vi.mocked(getEffectiveWorkflow).mockResolvedValue(workflow(source));
  vi.mocked(getWorkflowRules).mockResolvedValue([]);
  vi.mocked(listWorkflowTemplates).mockResolvedValue([]);
  render(<WorkflowPage />);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const CASES: Array<[string, string | null | undefined, boolean]> = [
  ["team ADMIN", "ADMIN", true],
  ["PROJECT_ADMIN without a team", "PROJECT_ADMIN", true],
  ["CONTRIBUTOR", "PROJECT_CONTRIBUTOR", false],
  ["VIEWER", "PROJECT_VIEWER", false],
  ["accessRole null", null, false],
  ["accessRole absent", undefined, false],
];

describe("workflow page editor gate (custom workflow)", () => {
  for (const [label, role, editable] of CASES) {
    it(`${label}: ${editable ? "editable" : "read-only"}`, async () => {
      setup("custom", role);
      if (editable) {
        await screen.findByText(/Edit states and gates below/);
        expect(screen.getByRole("button", { name: /Save/ })).toBeInTheDocument();
      } else {
        await screen.findByText(/Only project admins can edit\./);
        expect(screen.queryByRole("button", { name: /Save/ })).not.toBeInTheDocument();
      }
    });
  }
});

describe("workflow page customize gate (default workflow)", () => {
  for (const [label, role, editable] of CASES) {
    it(`${label}: ${editable ? "can customize" : "sees the project-admin hint"}`, async () => {
      setup("default", role);
      if (editable) {
        await screen.findByText(/Customize for this project/);
        expect(screen.queryByText(/Only project admins can customize/)).not.toBeInTheDocument();
      } else {
        await screen.findByText(/Only project admins can customize\./);
        expect(screen.queryByText(/Customize for this project/)).not.toBeInTheDocument();
      }
    });
  }
});

// canAdmin x accessRole. canAdmin wins whenever it is a boolean; accessRole
// decides only when canAdmin is absent.
const CAN_ADMIN_CASES: Array<[string, string, boolean | undefined, boolean]> = [
  ["canAdmin true, accessRole HUMAN_MEMBER (team member with PROJECT_ADMIN)", "HUMAN_MEMBER", true, true],
  ["canAdmin true, accessRole ADMIN", "ADMIN", true, true],
  ["canAdmin false, accessRole HUMAN_MEMBER", "HUMAN_MEMBER", false, false],
  ["canAdmin false, accessRole ADMIN (canAdmin wins)", "ADMIN", false, false],
  ["canAdmin absent, accessRole ADMIN (fallback)", "ADMIN", undefined, true],
  ["canAdmin absent, accessRole HUMAN_MEMBER (fallback)", "HUMAN_MEMBER", undefined, false],
];

describe("workflow page admin gate: canAdmin wins, accessRole is the fallback", () => {
  for (const [label, role, canAdmin, editable] of CAN_ADMIN_CASES) {
    it(`${label}: ${editable ? "editable" : "read-only"}`, async () => {
      setup("custom", role, canAdmin);
      if (editable) {
        await screen.findByText(/Edit states and gates below/);
        expect(screen.getByRole("button", { name: /Save/ })).toBeInTheDocument();
      } else {
        await screen.findByText(/Only project admins can edit\./);
        expect(screen.queryByRole("button", { name: /Save/ })).not.toBeInTheDocument();
      }
    });

    it(`${label}: default workflow ${editable ? "can customize" : "shows the hint"}`, async () => {
      setup("default", role, canAdmin);
      if (editable) {
        await screen.findByText(/Customize for this project/);
        expect(screen.queryByText(/Only project admins can customize/)).not.toBeInTheDocument();
      } else {
        await screen.findByText(/Only project admins can customize\./);
        expect(screen.queryByText(/Customize for this project/)).not.toBeInTheDocument();
      }
    });
  }
});
