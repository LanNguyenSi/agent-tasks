/** @vitest-environment jsdom */
/**
 * ConnectAgentModal — behaviour coverage for the one-click onboarding path.
 * The `createAgentToken` API is mocked so no network traffic fires; tests
 * pin down: scope shape, default tab, snippet substitution per client,
 * single-request-per-open guarantee, reopen semantics, and error handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../src/lib/api", () => ({
  createAgentToken: vi.fn(),
}));

import ConnectAgentModal from "../../src/components/ConnectAgentModal";
import { createAgentToken } from "../../src/lib/api";

const mockCreate = vi.mocked(createAgentToken);

function renderModal(open = true) {
  return render(
    <ConnectAgentModal
      open={open}
      onClose={() => {}}
      teamId="team-1"
      projectName="Pandora"
    />,
  );
}

describe("ConnectAgentModal", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({
      rawToken: "atk_live_test123",
      token: {
        id: "t-1",
        name: "Agent (Pandora) — 2026-04-14",
        scopes: ["tasks:read", "tasks:claim", "tasks:transition"],
        expiresAt: null,
        lastUsedAt: null,
        createdAt: new Date().toISOString(),
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("does not generate a token while closed", () => {
    renderModal(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("requests minimum-viable scopes and excludes tasks:create / projects:read", async () => {
    renderModal(true);
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));

    const call = mockCreate.mock.calls[0]![0];
    expect(call.teamId).toBe("team-1");

    // Must include the five scopes the happy path needs.
    expect(call.scopes).toEqual(
      expect.arrayContaining([
        "tasks:read",
        "tasks:claim",
        "tasks:comment",
        "tasks:transition",
        "tasks:update",
      ]),
    );

    // Must NOT include broader scopes — least-privilege regression guard.
    expect(call.scopes).not.toContain("tasks:create");
    expect(call.scopes).not.toContain("projects:read");

    // Must set an expiresAt (default-never-expire is a known footgun).
    expect(call.expiresAt).toBeTruthy();
    expect(new Date(call.expiresAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("renders the MCP snippet by default with the real token embedded", async () => {
    renderModal(true);

    const snippet = await screen.findByTestId("connect-snippet");
    expect(snippet.textContent).toContain("claude mcp add agent-tasks");
    expect(snippet.textContent).toContain(`AGENT_TASKS_TOKEN="atk_live_test123"`);

    const mcpTab = screen.getByTestId("connect-tab-mcp");
    expect(mcpTab).toHaveAttribute("aria-selected", "true");
    expect(mcpTab.textContent).toMatch(/recommended/i);
  });

  it("swaps the snippet when switching tabs but keeps the same token", async () => {
    renderModal(true);
    await screen.findByTestId("connect-snippet");

    const user = userEvent.setup();

    await user.click(screen.getByTestId("connect-tab-cli"));
    let snippet = screen.getByTestId("connect-snippet");
    // CLI snippet must use the real package name and both env vars.
    expect(snippet.textContent).toContain(`AGENT_TASKS_TOKEN="atk_live_test123"`);
    expect(snippet.textContent).toContain("agent-tasks-cli");
    expect(snippet.textContent).toContain("AGENT_TASKS_ENDPOINT");
    // Must NOT reference the non-existent @agent-tasks/cli package.
    expect(snippet.textContent).not.toContain("@agent-tasks/cli");

    await user.click(screen.getByTestId("connect-tab-api"));
    snippet = screen.getByTestId("connect-snippet");
    expect(snippet.textContent).toContain("Authorization: Bearer atk_live_test123");
    expect(snippet.textContent).toContain("/api/tasks");

    // Only one token generation across all tab switches.
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("surfaces the team-scope disclosure so users don't assume per-project", async () => {
    renderModal(true);
    await screen.findByTestId("connect-snippet");
    // The strong element carrying the team-scoped disclosure.
    expect(screen.getByText("team-scoped")).toBeInTheDocument();
  });

  it("generates a fresh token on reopen and does not fire during close", async () => {
    const { rerender } = render(
      <ConnectAgentModal open={true} onClose={() => {}} teamId="team-1" projectName="Pandora" />,
    );
    await screen.findByTestId("connect-snippet");
    expect(mockCreate).toHaveBeenCalledTimes(1);

    rerender(
      <ConnectAgentModal open={false} onClose={() => {}} teamId="team-1" projectName="Pandora" />,
    );
    expect(screen.queryByTestId("connect-snippet")).not.toBeInTheDocument();
    expect(mockCreate).toHaveBeenCalledTimes(1);

    rerender(
      <ConnectAgentModal open={true} onClose={() => {}} teamId="team-1" projectName="Pandora" />,
    );
    await screen.findByTestId("connect-snippet");
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("refuses to fire a second POST if the effect re-runs while the modal stays open", async () => {
    const { rerender } = render(
      <ConnectAgentModal open={true} onClose={() => {}} teamId="team-1" projectName="Pandora" />,
    );
    await screen.findByTestId("connect-snippet");
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // Re-render with identical props (simulates parent re-render, StrictMode
    // double invoke, or an unrelated state bump). Must NOT fire a second POST.
    rerender(
      <ConnectAgentModal open={true} onClose={() => {}} teamId="team-1" projectName="Pandora" />,
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("shows an error banner when token creation fails", async () => {
    mockCreate.mockReset();
    mockCreate.mockRejectedValue(new Error("Only team admins can create agent tokens"));
    renderModal(true);

    await screen.findByText(/could not generate token/i);
    expect(screen.getByText(/only team admins/i)).toBeInTheDocument();
    expect(screen.queryByTestId("connect-snippet")).not.toBeInTheDocument();
  });
});
