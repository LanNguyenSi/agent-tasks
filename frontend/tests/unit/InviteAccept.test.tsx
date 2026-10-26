/** @vitest-environment jsdom */
/**
 * Invite landing page (/invite/[token]) after a successful accept: the soft
 * auto-redirect and the "go now" link both target the project's board at
 * /projects/<id>/board (T07), not the members page. The already_member error
 * path keeps its "Back to home" link to /home.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { ApiRequestError, type User, type InvitePreview } from "../../src/lib/api";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push }),
  useParams: () => ({ token: "tok-1" }),
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    getCurrentUser: vi.fn(),
    previewInvite: vi.fn(),
    acceptInvite: vi.fn(),
  };
});

import InviteLandingPage from "../../src/app/invite/[token]/page";
import { getCurrentUser, previewInvite, acceptInvite } from "../../src/lib/api";

const mockGetCurrentUser = vi.mocked(getCurrentUser);
const mockPreviewInvite = vi.mocked(previewInvite);
const mockAcceptInvite = vi.mocked(acceptInvite);

const USER = {
  id: "u-1",
  login: "lan",
  name: "Lan",
  avatarUrl: null,
  email: null,
  githubConnected: false,
  allowAgentPrCreate: false,
  allowAgentPrMerge: false,
  allowAgentPrComment: false,
} as User;

const PREVIEW = {
  projectId: "p-9",
  projectName: "Project Nine",
  projectSlug: "project-nine",
  ownerLogin: "owner",
  role: "PROJECT_CONTRIBUTOR",
  expiresAt: "2030-01-01T00:00:00.000Z",
} as InvitePreview;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(USER);
  mockPreviewInvite.mockResolvedValue(PREVIEW);
  mockAcceptInvite.mockResolvedValue({
    projectId: "p-9",
    role: "PROJECT_CONTRIBUTOR",
    soloModeChanged: false,
  });
});

async function accept(): Promise<void> {
  render(<InviteLandingPage />);
  const button = await screen.findByRole("button", { name: /accept invitation/i });
  fireEvent.click(button);
  await screen.findByText(/welcome aboard/i);
}

describe("accepting an invite", () => {
  it("routes to the project board, not the members page", async () => {
    await accept();
    // The page pushes after a 1500ms pause; outwait it.
    await waitFor(() => expect(nav.push).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(nav.push).toHaveBeenCalledWith("/projects/p-9/board");
  });

  it("points the \"go now\" link at the same board URL", async () => {
    await accept();
    expect(screen.getByRole("link", { name: "go now" })).toHaveAttribute(
      "href",
      "/projects/p-9/board",
    );
  });
});

describe("invite errors", () => {
  it("keeps the \"Back to home\" link on the already_member screen", async () => {
    mockPreviewInvite.mockRejectedValue(
      new ApiRequestError("already_member", "already a member", 409),
    );
    render(<InviteLandingPage />);
    await screen.findByText(/already have access/i);
    // AuthShell has its own "Back to home" logo link to "/"; the error-body
    // one must still point at /home.
    const homeLinks = screen
      .getAllByRole("link", { name: "Back to home" })
      .map((link) => link.getAttribute("href"));
    expect(homeLinks).toContain("/home");
    expect(nav.push).not.toHaveBeenCalled();
  });
});
