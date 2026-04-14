/** @vitest-environment jsdom */
/**
 * ConnectAgentModal — smoke coverage for the onboarding shortcut that
 * (a) generates a token once when the modal opens, (b) renders the
 * MCP tab by default, and (c) substitutes the real token into every
 * per-client install snippet. The token API is mocked; no network.
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

  it("generates a token on open and embeds it in the MCP snippet by default", async () => {
    renderModal(true);

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));

    const call = mockCreate.mock.calls[0]![0];
    expect(call.teamId).toBe("team-1");
    expect(call.scopes).toContain("tasks:read");
    expect(call.scopes).toContain("tasks:claim");
    expect(call.scopes).toContain("tasks:transition");

    const snippet = await screen.findByTestId("connect-snippet");
    expect(snippet.textContent).toContain("claude mcp add agent-tasks");
    expect(snippet.textContent).toContain(`AGENT_TASKS_TOKEN="atk_live_test123"`);

    // MCP tab is the default and flagged as Recommended.
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
    expect(snippet.textContent).toContain(`export AGENT_TASKS_TOKEN="atk_live_test123"`);
    expect(snippet.textContent).toContain("npx -y @agent-tasks/cli");

    await user.click(screen.getByTestId("connect-tab-api"));
    snippet = screen.getByTestId("connect-snippet");
    expect(snippet.textContent).toContain("Authorization: Bearer atk_live_test123");
    expect(snippet.textContent).toContain("/api/tasks");

    // Only one token was ever generated.
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("generates a fresh token on reopen and drops in-flight results from a closed modal", async () => {
    const { rerender } = render(
      <ConnectAgentModal open={true} onClose={() => {}} teamId="team-1" projectName="Pandora" />,
    );
    await screen.findByTestId("connect-snippet");
    expect(mockCreate).toHaveBeenCalledTimes(1);

    rerender(
      <ConnectAgentModal open={false} onClose={() => {}} teamId="team-1" projectName="Pandora" />,
    );
    // Snippet unmounts.
    expect(screen.queryByTestId("connect-snippet")).not.toBeInTheDocument();

    rerender(
      <ConnectAgentModal open={true} onClose={() => {}} teamId="team-1" projectName="Pandora" />,
    );
    await screen.findByTestId("connect-snippet");
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("shows an error banner when token creation fails", async () => {
    mockCreate.mockReset();
    mockCreate.mockRejectedValue(new Error("forbidden"));
    renderModal(true);

    await screen.findByText(/could not generate token/i);
    expect(screen.getByText(/forbidden/i)).toBeInTheDocument();
    expect(screen.queryByTestId("connect-snippet")).not.toBeInTheDocument();
  });
});
