/** @vitest-environment jsdom */
/**
 * Project settings page: the General card (project details moved here from
 * the dropped Overview tab), same full-page render pattern as
 * ProjectSettingsPage.allowNonCreatorRespec.test.tsx.
 *
 * Covers:
 *   - General is the first card, with the slug and the created date;
 *   - the GitHub repository row appears as a github.com link when set;
 *   - with githubRepo null the repository row is hidden but slug and
 *     created still render;
 *   - governance is not duplicated in General (it stays editable only in
 *     the Governance card) and the dropped Overview's status-count row is
 *     gone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { Project, User } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
  useParams: () => ({ id: "proj-1" }),
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getProject: vi.fn(),
  updateProject: vi.fn(),
}));

import ProjectSettingsPage from "../../src/app/projects/[id]/settings/page";
import { getCurrentUser, getProject } from "../../src/lib/api";

const mockGetCurrentUser = vi.mocked(getCurrentUser);
const mockGetProject = vi.mocked(getProject);

function makeUser(): User {
  return {
    id: "u-1",
    login: "lan",
    name: "Lan",
    avatarUrl: null,
    email: "lan@example.com",
    githubConnected: false,
    allowAgentPrCreate: false,
    allowAgentPrMerge: false,
    allowAgentPrComment: false,
  };
}

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    teamId: "team-1",
    name: "agent-tasks",
    slug: "gen-slug",
    description: null,
    githubRepo: null,
    githubSyncAt: "2024-01-01T00:00:00Z",
    taskTemplate: null,
    confidenceThreshold: 60,
    requireDistinctReviewer: false,
    soloMode: false,
    governanceMode: "AWAITS_CONFIRMATION",
    notificationWebhookUrl: null,
    hasNotificationWebhookSecret: false,
    allowNonCreatorRespec: false,
    createdAt: "2026-03-05T12:00:00",
    ...over,
  } as Project;
}

async function renderPage(project: Project) {
  mockGetProject.mockResolvedValue(project);
  render(<ProjectSettingsPage />);
  await screen.findByText("General");
}

beforeEach(() => {
  mockGetCurrentUser.mockResolvedValue(makeUser());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProjectSettingsPage General card", () => {
  it("is the first card and shows slug and created date", async () => {
    await renderPage(makeProject());
    const heads = Array.from(
      document.querySelectorAll(".proj-section-head"),
    ).map((el) => el.textContent);
    expect(heads[0]).toBe("General");
    const metaLabels = Array.from(
      document.querySelectorAll(".proj-meta-label"),
    ).map((el) => el.textContent);
    expect(metaLabels).toContain("Slug");
    expect(metaLabels).toContain("Created");
    expect(
      screen.getByText("Slug").nextElementSibling,
    ).toHaveTextContent("gen-slug");
    const created = screen
      .getByText("Created")
      .nextElementSibling?.textContent ?? "";
    expect(created).toContain("2026");
    expect(created).not.toContain("2024");
  });

  it("links the GitHub repository when the project has one", async () => {
    await renderPage(makeProject({ githubRepo: "acme/widgets" }));
    const link = screen.getByRole("link", { name: "acme/widgets" });
    expect(link).toHaveAttribute("href", "https://github.com/acme/widgets");
  });

  it("hides the repository row when githubRepo is null, keeping slug and created", async () => {
    await renderPage(makeProject({ githubRepo: null }));
    expect(screen.queryByText("GitHub repository")).not.toBeInTheDocument();
    expect(screen.getByText("Slug")).toBeInTheDocument();
    expect(screen.getByText("Created")).toBeInTheDocument();
  });

  it("does not duplicate governance or the dropped status-count row", async () => {
    await renderPage(makeProject());
    expect(screen.getAllByText("Governance")).toHaveLength(1);
    const metaLabels = Array.from(
      document.querySelectorAll(".proj-meta-label"),
    ).map((el) => el.textContent);
    expect(metaLabels).not.toContain("Governance");
    expect(document.querySelector(".proj-stat-row")).toBeNull();
  });
});
