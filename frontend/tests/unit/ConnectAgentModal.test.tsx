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

import ConnectAgentModal, {
  __setMaskDelayForTests,
} from "../../src/components/ConnectAgentModal";
import { createAgentToken } from "../../src/lib/api";

// Drop the 30s mask delay to something tests can wait on without
// slowing the suite. Production keeps the 30s default.
__setMaskDelayForTests(50);

const mockCreate = vi.mocked(createAgentToken);

function renderModal(open = true) {
  return render(
    <ConnectAgentModal
      open={open}
      onClose={() => {}}
      teamId="team-1"
      scopeLabel="Pandora Team"
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
    // Restore real timers in case an earlier test bailed before its own
    // cleanup — otherwise the next test's waitFor would deadlock.
    vi.useRealTimers();
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
      <ConnectAgentModal open={true} onClose={() => {}} teamId="team-1" scopeLabel="Pandora Team" />,
    );
    await screen.findByTestId("connect-snippet");
    expect(mockCreate).toHaveBeenCalledTimes(1);

    rerender(
      <ConnectAgentModal open={false} onClose={() => {}} teamId="team-1" scopeLabel="Pandora Team" />,
    );
    expect(screen.queryByTestId("connect-snippet")).not.toBeInTheDocument();
    expect(mockCreate).toHaveBeenCalledTimes(1);

    rerender(
      <ConnectAgentModal open={true} onClose={() => {}} teamId="team-1" scopeLabel="Pandora Team" />,
    );
    await screen.findByTestId("connect-snippet");
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("refuses to fire a second POST if the effect re-runs while the modal stays open", async () => {
    const tokenSpy = vi.fn();
    const { rerender } = render(
      <ConnectAgentModal
        open={true}
        onClose={() => {}}
        teamId="team-1"
        scopeLabel="Pandora Team"
        onTokenCreated={tokenSpy}
      />,
    );
    await screen.findByTestId("connect-snippet");
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(tokenSpy).toHaveBeenCalledTimes(1);

    // Re-render with identical props (simulates parent re-render, StrictMode
    // double invoke, or an unrelated state bump). Must NOT fire a second POST
    // AND must NOT fire onTokenCreated a second time — otherwise Settings
    // would insert the same row twice into its visible token list.
    rerender(
      <ConnectAgentModal
        open={true}
        onClose={() => {}}
        teamId="team-1"
        scopeLabel="Pandora Team"
        onTokenCreated={tokenSpy}
      />,
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(tokenSpy).toHaveBeenCalledTimes(1);
  });

  it("calls onTokenCreated after successful generation so parent can refresh its token list", async () => {
    const spy = vi.fn();
    render(
      <ConnectAgentModal
        open={true}
        onClose={() => {}}
        teamId="team-1"
        scopeLabel="Pandora Team"
        onTokenCreated={spy}
      />,
    );
    await screen.findByTestId("connect-snippet");
    expect(spy).toHaveBeenCalledTimes(1);
    const passedToken = spy.mock.calls[0]![0];
    expect(passedToken.id).toBe("t-1");
    expect(passedToken.scopes).toContain("tasks:claim");
  });

  it("masks the token in the DOM after Copy snippet and exposes a Reveal button", async () => {
    renderModal(true);

    const snippet = await screen.findByTestId("connect-snippet");
    expect(snippet.textContent).toContain("atk_live_test123");
    expect(snippet).toHaveAttribute("data-token-masked", "false");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /copy snippet/i }));

    // Wait for the mask timer to fire — the test-env delay is 50ms
    // (see setMaskDelayForTests at bottom of the component file).
    await waitFor(
      () => {
        expect(screen.getByTestId("connect-snippet")).toHaveAttribute(
          "data-token-masked",
          "true",
        );
      },
      { timeout: 1000 },
    );

    const masked = screen.getByTestId("connect-snippet");
    expect(masked.textContent).not.toContain("atk_live_test123");
    expect(masked.textContent).toContain("••••••••");

    // Reveal restores the raw token.
    await user.click(screen.getByTestId("connect-reveal"));
    expect(screen.getByTestId("connect-snippet").textContent).toContain(
      "atk_live_test123",
    );
    expect(screen.getByTestId("connect-snippet")).toHaveAttribute(
      "data-token-masked",
      "false",
    );
  });

  it("exposes the HTTP MCP transport alternative under the MCP tab only", async () => {
    renderModal(true);
    await screen.findByTestId("connect-snippet");

    // Disclosure present under the MCP tab (default), collapsed content
    // still renders into the DOM so we can assert its shape.
    const details = screen.getByTestId("connect-mcp-http-alt");
    expect(details.tagName.toLowerCase()).toBe("details");

    const httpSnippet = screen.getByTestId("connect-mcp-http-snippet");
    expect(httpSnippet.textContent).toContain(
      "claude mcp add --transport http agent-tasks",
    );
    expect(httpSnippet.textContent).toContain("/api/mcp");
    expect(httpSnippet.textContent).toContain(
      `Authorization: Bearer atk_live_test123`,
    );

    // Not shown on other tabs — the HTTP transport only matches the
    // Claude Code MCP client flow, not the CLI or curl paths.
    const user = userEvent.setup();
    await user.click(screen.getByTestId("connect-tab-cli"));
    expect(screen.queryByTestId("connect-mcp-http-alt")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("connect-tab-api"));
    expect(screen.queryByTestId("connect-mcp-http-alt")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("connect-tab-mcp"));
    expect(screen.getByTestId("connect-mcp-http-alt")).toBeInTheDocument();
  });

  it("passes an AbortSignal to createAgentToken and aborts it when the modal closes mid-flight", async () => {
    // Hold the mock pending so we can close the modal while the
    // request is still in flight. The effect cleanup should call
    // controller.abort() on the signal we gave it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolvePending: (value: any) => void = () => {};
    mockCreate.mockReset();
    mockCreate.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePending = resolve;
        }),
    );

    const { rerender } = render(
      <ConnectAgentModal
        open={true}
        onClose={() => {}}
        teamId="team-1"
        scopeLabel="Pandora Team"
      />,
    );

    // The request was fired with a signal in the second argument.
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    const [, options] = mockCreate.mock.calls[0]!;
    expect(options).toBeDefined();
    expect(options!.signal).toBeInstanceOf(AbortSignal);
    expect(options!.signal!.aborted).toBe(false);

    // Close the modal mid-flight — effect cleanup must abort the signal.
    rerender(
      <ConnectAgentModal
        open={false}
        onClose={() => {}}
        teamId="team-1"
        scopeLabel="Pandora Team"
      />,
    );
    expect(options!.signal!.aborted).toBe(true);

    // Resolve the stale request AFTER abort — must NOT render the
    // snippet (the effect's cancelled flag swallows late resolves).
    resolvePending({
      rawToken: "atk_live_late",
      token: {
        id: "t-late",
        name: "late",
        scopes: [],
        expiresAt: null,
        lastUsedAt: null,
        createdAt: new Date().toISOString(),
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("connect-snippet")).not.toBeInTheDocument();
  });

  it("does NOT call onTokenCreated when the backend rejects the request", async () => {
    mockCreate.mockReset();
    mockCreate.mockRejectedValue(new Error("Only team admins can create agent tokens"));
    const spy = vi.fn();
    render(
      <ConnectAgentModal
        open={true}
        onClose={() => {}}
        teamId="team-1"
        scopeLabel="Pandora Team"
        onTokenCreated={spy}
      />,
    );

    await screen.findByText(/could not generate token/i);
    expect(screen.getByText(/only team admins/i)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });
});
