/** @vitest-environment jsdom */
/**
 * ConnectAgentModal -- behaviour coverage for the one-click onboarding path.
 *
 * KEY CONTRACT CHANGE (stage G1):
 *   The modal NO LONGER mints a token on open. Opening the modal shows the
 *   scope/TTL summary and a "Generate token" button. The POST fires only when
 *   the user explicitly clicks that button. Closing before clicking leaves no
 *   orphan token.
 *
 * Tests pin down: no-POST-on-open guarantee, explicit-generate contract, scope
 * shape, default tab, snippet substitution per client, reopen semantics, and
 * error handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
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

function makeTokenResult(rawToken = "at_live_test123") {
  return {
    rawToken,
    token: {
      id: "t-1",
      name: "Agent (Pandora) -- 2026-04-14",
      scopes: ["tasks:read", "tasks:claim", "tasks:transition"],
      expiresAt: null,
      lastUsedAt: null,
      createdAt: new Date().toISOString(),
    },
  };
}

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
    mockCreate.mockResolvedValue(makeTokenResult());
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  // --- Core contract: no mint on open ---------------------------------

  it("does NOT call createAgentToken when the modal opens", () => {
    renderModal(true);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("does NOT call createAgentToken when the modal opens and then closes without clicking Generate", async () => {
    const { rerender } = renderModal(true);
    // Close without generating
    rerender(
      <ConnectAgentModal
        open={false}
        onClose={() => {}}
        teamId="team-1"
        scopeLabel="Pandora Team"
      />,
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("shows the scope/TTL summary and a Generate token button before generation", () => {
    renderModal(true);
    // Summary text about the token characteristics
    expect(screen.getByText("team-scoped")).toBeInTheDocument();
    // Explicit generate button
    expect(
      screen.getByTestId("connect-generate-btn"),
    ).toBeInTheDocument();
    // No snippet yet
    expect(screen.queryByTestId("connect-snippet")).not.toBeInTheDocument();
  });

  // --- Explicit generate flow -----------------------------------------

  it("calls createAgentToken only after the user clicks Generate token", async () => {
    renderModal(true);
    expect(mockCreate).not.toHaveBeenCalled();

    const user = userEvent.setup();
    await user.click(screen.getByTestId("connect-generate-btn"));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    // Snippet now visible
    await screen.findByTestId("connect-snippet");
  });

  it("requests minimum-viable scopes and excludes tasks:create / projects:read", async () => {
    renderModal(true);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("connect-generate-btn"));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));

    const call = mockCreate.mock.calls[0]![0];
    expect(call.teamId).toBe("team-1");
    expect(call.scopes).toEqual(
      expect.arrayContaining([
        "tasks:read",
        "tasks:claim",
        "tasks:comment",
        "tasks:transition",
        "tasks:update",
      ]),
    );
    // Least-privilege guard
    expect(call.scopes).not.toContain("tasks:create");
    expect(call.scopes).not.toContain("projects:read");
    // Must set expiry
    expect(call.expiresAt).toBeTruthy();
    expect(new Date(call.expiresAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("renders the MCP snippet by default with the real token embedded", async () => {
    renderModal(true);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("connect-generate-btn"));

    const snippet = await screen.findByTestId("connect-snippet");
    expect(snippet.textContent).toContain("claude mcp add agent-tasks");
    expect(snippet.textContent).toContain(`AGENT_TASKS_TOKEN="at_live_test123"`);
  });

  it("links the saved-token note to Team settings, API Tokens section", async () => {
    renderModal(true);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("connect-generate-btn"));
    await screen.findByTestId("connect-snippet");

    // The modal knows its team (required prop), so the link carries it:
    // /settings/team opens that team instead of resolving and rewriting.
    expect(
      screen.getByRole("link", { name: /team settings.*api tokens/i }),
    ).toHaveAttribute("href", "/settings/team?teamId=team-1#api-tokens");
  });

  it("swaps the snippet when switching tabs but keeps the same token and does not re-mint", async () => {
    renderModal(true);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("connect-generate-btn"));
    await screen.findByTestId("connect-snippet");

    // The shared Tabs component renders accessible tab buttons by label.
    await user.click(screen.getByRole("tab", { name: /cli/i }));
    let snippet = screen.getByTestId("connect-snippet");
    expect(snippet.textContent).toContain(`AGENT_TASKS_TOKEN="at_live_test123"`);
    // The CLI is not on npm: the snippet must build it from a checkout and
    // run the built entry point, never `npx @agent-tasks/cli`.
    expect(snippet.textContent).toContain("npm run build --workspace=@agent-tasks/cli");
    expect(snippet.textContent).toContain("node cli/dist/index.js tasks list");
    expect(snippet.textContent).not.toContain("npx");
    expect(snippet.textContent).toContain("AGENT_TASKS_ENDPOINT");
    expect(snippet.textContent).not.toContain("agent-tasks-cli");

    await user.click(screen.getByRole("tab", { name: /curl/i }));
    snippet = screen.getByTestId("connect-snippet");
    expect(snippet.textContent).toContain("Authorization: Bearer at_live_test123");
    expect(snippet.textContent).toContain("/api/tasks");

    // Only one token generation across all tab switches.
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("surfaces the team-scope disclosure so users don't assume per-project", async () => {
    renderModal(true);
    expect(screen.getByText("team-scoped")).toBeInTheDocument();
  });

  it("generates a fresh token on reopen", async () => {
    const { rerender } = render(
      <ConnectAgentModal
        open={true}
        onClose={() => {}}
        teamId="team-1"
        scopeLabel="Pandora Team"
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByTestId("connect-generate-btn"));
    await screen.findByTestId("connect-snippet");
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // Close resets state
    rerender(
      <ConnectAgentModal
        open={false}
        onClose={() => {}}
        teamId="team-1"
        scopeLabel="Pandora Team"
      />,
    );
    expect(screen.queryByTestId("connect-snippet")).not.toBeInTheDocument();

    // Reopen: still no POST until user clicks Generate
    rerender(
      <ConnectAgentModal
        open={true}
        onClose={() => {}}
        teamId="team-1"
        scopeLabel="Pandora Team"
      />,
    );
    // Generate button is back, no snippet yet
    expect(screen.getByTestId("connect-generate-btn")).toBeInTheDocument();
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // Generate on the second open
    await user.click(screen.getByTestId("connect-generate-btn"));
    await screen.findByTestId("connect-snippet");
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("calls onTokenCreated after successful generation", async () => {
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

    const user = userEvent.setup();
    await user.click(screen.getByTestId("connect-generate-btn"));
    await screen.findByTestId("connect-snippet");

    expect(spy).toHaveBeenCalledTimes(1);
    const passedToken = spy.mock.calls[0]![0];
    expect(passedToken.id).toBe("t-1");
    expect(passedToken.scopes).toContain("tasks:claim");
  });

  it("does NOT call onTokenCreated when closed before generating", () => {
    const spy = vi.fn();
    const { rerender } = render(
      <ConnectAgentModal
        open={true}
        onClose={() => {}}
        teamId="team-1"
        scopeLabel="Pandora Team"
        onTokenCreated={spy}
      />,
    );
    // Close without clicking Generate
    rerender(
      <ConnectAgentModal
        open={false}
        onClose={() => {}}
        teamId="team-1"
        scopeLabel="Pandora Team"
        onTokenCreated={spy}
      />,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("surfaces an error banner when the backend rejects and does NOT call onTokenCreated", async () => {
    mockCreate.mockReset();
    mockCreate.mockRejectedValue(
      new Error("Only team admins can create agent tokens"),
    );
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

    const user = userEvent.setup();
    await user.click(screen.getByTestId("connect-generate-btn"));

    await screen.findByText(/could not generate token/i);
    expect(screen.getByText(/only team admins/i)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("exposes the HTTP MCP transport alternative under the MCP tab only", async () => {
    renderModal(true);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("connect-generate-btn"));
    await screen.findByTestId("connect-snippet");

    // Disclosure present under the MCP tab (default)
    const details = screen.getByTestId("connect-mcp-http-alt");
    expect(details.tagName.toLowerCase()).toBe("details");

    const httpSnippet = screen.getByTestId("connect-mcp-http-snippet");
    expect(httpSnippet.textContent).toContain("claude mcp add --transport http agent-tasks");
    expect(httpSnippet.textContent).toContain("/api/mcp");
    expect(httpSnippet.textContent).toContain("Authorization: Bearer at_live_test123");

    // Not shown on CLI tab (tab buttons accessible by label)
    await user.click(screen.getByRole("tab", { name: /cli/i }));
    expect(screen.queryByTestId("connect-mcp-http-alt")).not.toBeInTheDocument();

    // Not shown on API tab
    await user.click(screen.getByRole("tab", { name: /curl/i }));
    expect(screen.queryByTestId("connect-mcp-http-alt")).not.toBeInTheDocument();

    // Back to MCP: shown again
    await user.click(screen.getByRole("tab", { name: /claude code/i }));
    expect(screen.getByTestId("connect-mcp-http-alt")).toBeInTheDocument();
  });

  it("masks the token in the snippet after the mask delay, exposes a Reveal button", async () => {
    renderModal(true);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("connect-generate-btn"));

    const snippet = await screen.findByTestId("connect-snippet");
    expect(snippet.textContent).toContain("at_live_test123");
    expect(snippet).toHaveAttribute("data-token-masked", "false");

    // Trigger the mask timer by clicking "Copy snippet"
    await user.click(screen.getByRole("button", { name: /copy snippet/i }));

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
    expect(masked.textContent).not.toContain("at_live_test123");
    expect(masked.textContent).toContain("••••••••");

    // Reveal restores the raw token
    await user.click(screen.getByTestId("connect-reveal"));
    expect(screen.getByTestId("connect-snippet").textContent).toContain(
      "at_live_test123",
    );
    expect(screen.getByTestId("connect-snippet")).toHaveAttribute(
      "data-token-masked",
      "false",
    );
  });
});

/**
 * The secret of a created token exists only in the create response. When the
 * dialog cannot show it (closed, or gone with its section, before the
 * response arrives; or unmounted while it still shows it) it is handed to the
 * parent instead of being kept in dead state or dropped.
 */
describe("ConnectAgentModal: a result the dialog cannot show", () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  type CreateResult = ReturnType<typeof makeTokenResult>;
  const SECRET = "at_live_SECRET_0123456789";

  function dialog(
    props: {
      open?: boolean;
      teamId?: string;
      onTokenCreated?: (t: unknown) => void;
      onSecretUnseen?: (s: unknown) => void;
      onCreateFailedUnseen?: (teamId: string, message: string) => void;
    } = {},
  ) {
    return (
      <ConnectAgentModal
        open={props.open ?? true}
        onClose={() => {}}
        teamId={props.teamId ?? "team-1"}
        scopeLabel="Pandora Team"
        onTokenCreated={props.onTokenCreated}
        onSecretUnseen={props.onSecretUnseen}
        onCreateFailedUnseen={props.onCreateFailedUnseen}
      />
    );
  }

  beforeEach(() => {
    mockCreate.mockReset();
  });
  afterEach(() => {
    cleanup();
  });

  it("shown in the dialog: the token is announced to the list and nothing is handed over", async () => {
    mockCreate.mockResolvedValue(makeTokenResult(SECRET));
    const created = vi.fn();
    const unseen = vi.fn();
    render(dialog({ onTokenCreated: created, onSecretUnseen: unseen }));

    await userEvent.setup().click(screen.getByTestId("connect-generate-btn"));
    await screen.findByTestId("connect-snippet");

    expect(screen.getByTestId("connect-snippet").textContent).toContain(SECRET);
    expect(created).toHaveBeenCalledTimes(1);
    expect(unseen).not.toHaveBeenCalled();
  });

  it("closed while the request is pending: the secret is handed over, not shown or kept", async () => {
    const pending = deferred<CreateResult>();
    mockCreate.mockReturnValue(pending.promise);
    const created = vi.fn();
    const unseen = vi.fn();
    const { rerender } = render(dialog({ onTokenCreated: created, onSecretUnseen: unseen }));
    await userEvent.setup().click(screen.getByTestId("connect-generate-btn"));

    rerender(dialog({ open: false, onTokenCreated: created, onSecretUnseen: unseen }));
    await act(async () => {
      pending.resolve(makeTokenResult(SECRET));
    });

    expect(unseen).toHaveBeenCalledTimes(1);
    expect(unseen).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "team-1", rawToken: SECRET}),
    );
    // The list is not told by the dialog: the parent adds the token itself.
    expect(created).not.toHaveBeenCalled();
    // Reopening starts clean: no stale secret from the closed session.
    rerender(dialog({ open: true, onTokenCreated: created, onSecretUnseen: unseen }));
    expect(screen.getByTestId("connect-generate-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("connect-snippet")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("closed and reopened while pending: the old response does not write into the new session", async () => {
    const first = deferred<CreateResult>();
    mockCreate.mockReturnValueOnce(first.promise);
    const created = vi.fn();
    const unseen = vi.fn();
    const { rerender } = render(dialog({ onTokenCreated: created, onSecretUnseen: unseen }));
    await userEvent.setup().click(screen.getByTestId("connect-generate-btn"));
    rerender(dialog({ open: false, onTokenCreated: created, onSecretUnseen: unseen }));
    rerender(dialog({ open: true, onTokenCreated: created, onSecretUnseen: unseen }));

    await act(async () => {
      first.resolve(makeTokenResult(SECRET));
    });

    expect(unseen).toHaveBeenCalledWith(expect.objectContaining({ rawToken: SECRET}));
    expect(screen.queryByTestId("connect-snippet")).not.toBeInTheDocument();
    // The new session is not left loading or filled by the old request.
    expect(screen.getByTestId("connect-generate-btn")).not.toBeDisabled();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("closed and reopened, then a second request is pending: the first response does not end its loading state", async () => {
    const first = deferred<CreateResult>();
    const second = deferred<CreateResult>();
    mockCreate.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const unseen = vi.fn();
    const { rerender } = render(dialog({ onSecretUnseen: unseen }));
    const user = userEvent.setup();
    await user.click(screen.getByTestId("connect-generate-btn"));
    rerender(dialog({ open: false, onSecretUnseen: unseen }));
    rerender(dialog({ open: true, onSecretUnseen: unseen }));
    await user.click(screen.getByTestId("connect-generate-btn"));
    expect(screen.getByTestId("connect-generate-btn")).toBeDisabled();

    await act(async () => {
      first.resolve(makeTokenResult("at_live_FIRST_0123456789"));
    });

    expect(unseen).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("connect-generate-btn")).toBeDisabled();
    expect(screen.queryByTestId("connect-snippet")).not.toBeInTheDocument();

    // The second request still belongs to this session and is shown.
    await act(async () => {
      second.resolve(makeTokenResult(SECRET));
    });
    expect((await screen.findByTestId("connect-snippet")).textContent).toContain(SECRET);
    expect(unseen).toHaveBeenCalledTimes(1);
  });

  it("unmounted while the request is pending: the secret is handed over with the team it was requested for", async () => {
    const pending = deferred<CreateResult>();
    mockCreate.mockReturnValue(pending.promise);
    const unseen = vi.fn();
    const view = render(dialog({ teamId: "team-1", onSecretUnseen: unseen }));
    await userEvent.setup().click(screen.getByTestId("connect-generate-btn"));
    // The page now shows another team; the request was for team-1.
    view.rerender(dialog({ teamId: "team-2", onSecretUnseen: unseen }));

    view.unmount();
    await act(async () => {
      pending.resolve(makeTokenResult(SECRET));
    });

    expect(unseen).toHaveBeenCalledTimes(1);
    expect(unseen).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "team-1", rawToken: SECRET}),
    );
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("the hand-over goes to the parent's latest callback", async () => {
    const pending = deferred<CreateResult>();
    mockCreate.mockReturnValue(pending.promise);
    const oldCb = vi.fn();
    const newCb = vi.fn();
    const view = render(dialog({ onSecretUnseen: oldCb }));
    await userEvent.setup().click(screen.getByTestId("connect-generate-btn"));
    view.rerender(dialog({ open: false, onSecretUnseen: newCb }));

    await act(async () => {
      pending.resolve(makeTokenResult(SECRET));
    });

    expect(newCb).toHaveBeenCalledTimes(1);
    expect(oldCb).not.toHaveBeenCalled();
  });

  it("unmounted while it shows the secret: the secret is handed over once", async () => {
    mockCreate.mockResolvedValue(makeTokenResult(SECRET));
    const created = vi.fn();
    const unseen = vi.fn();
    const view = render(dialog({ onTokenCreated: created, onSecretUnseen: unseen }));
    await userEvent.setup().click(screen.getByTestId("connect-generate-btn"));
    await screen.findByTestId("connect-snippet");
    expect(unseen).not.toHaveBeenCalled();

    view.unmount();

    expect(unseen).toHaveBeenCalledTimes(1);
    expect(unseen).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "team-1", rawToken: SECRET}),
    );
    expect(created).toHaveBeenCalledTimes(1);
  });

  it("closed by the user while it shows the secret: nothing is handed over, the secret is gone", async () => {
    mockCreate.mockResolvedValue(makeTokenResult(SECRET));
    const unseen = vi.fn();
    const view = render(dialog({ onSecretUnseen: unseen }));
    await userEvent.setup().click(screen.getByTestId("connect-generate-btn"));
    await screen.findByTestId("connect-snippet");

    view.rerender(dialog({ open: false, onSecretUnseen: unseen }));
    view.unmount();

    expect(unseen).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("unmounted before it ever shows a secret: nothing is handed over", () => {
    const unseen = vi.fn();
    render(dialog({ onSecretUnseen: unseen })).unmount();
    expect(unseen).not.toHaveBeenCalled();
  });

  it("a failure while the dialog is open is shown in it, not reported to the parent", async () => {
    mockCreate.mockRejectedValue(new Error("Token service unavailable"));
    const failed = vi.fn();
    render(dialog({ onCreateFailedUnseen: failed }));

    await userEvent.setup().click(screen.getByTestId("connect-generate-btn"));

    expect(await screen.findByText("Token service unavailable")).toBeInTheDocument();
    expect(failed).not.toHaveBeenCalled();
  });

  it("a failure after the dialog was closed is reported with its team and not shown on reopen", async () => {
    const pending = deferred<CreateResult>();
    mockCreate.mockReturnValue(pending.promise);
    const failed = vi.fn();
    const unseen = vi.fn();
    const { rerender } = render(dialog({ onCreateFailedUnseen: failed, onSecretUnseen: unseen }));
    await userEvent.setup().click(screen.getByTestId("connect-generate-btn"));
    rerender(dialog({ open: false, onCreateFailedUnseen: failed, onSecretUnseen: unseen }));

    await act(async () => {
      pending.reject(new Error("Token service unavailable"));
    });

    expect(failed).toHaveBeenCalledWith("team-1", "Token service unavailable");
    expect(unseen).not.toHaveBeenCalled();
    rerender(dialog({ open: true, onCreateFailedUnseen: failed, onSecretUnseen: unseen }));
    expect(screen.queryByText("Token service unavailable")).not.toBeInTheDocument();
  });

  it("a failure after unmount is reported with the team it was requested for", async () => {
    const pending = deferred<CreateResult>();
    mockCreate.mockReturnValue(pending.promise);
    const failed = vi.fn();
    const unseen = vi.fn();
    const view = render(dialog({ teamId: "team-1", onCreateFailedUnseen: failed, onSecretUnseen: unseen }));
    await userEvent.setup().click(screen.getByTestId("connect-generate-btn"));
    view.unmount();

    await act(async () => {
      pending.reject(new Error("Token service unavailable"));
    });

    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledWith("team-1", "Token service unavailable");
    expect(unseen).not.toHaveBeenCalled();
  });

  it("without handlers a result the dialog cannot show is dropped without throwing", async () => {
    const ok = deferred<CreateResult>();
    mockCreate.mockReturnValueOnce(ok.promise);
    const view = render(dialog());
    await userEvent.setup().click(screen.getByTestId("connect-generate-btn"));
    view.unmount();

    await act(async () => {
      ok.resolve(makeTokenResult(SECRET));
    });

    expect(document.body.textContent).not.toContain(SECRET);
  });
});
