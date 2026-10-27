"use client";

import { useEffect, useRef, useState } from "react";
import Modal from "./ui/Modal";
import { Button } from "./ui/Button";
import AlertBanner from "./ui/AlertBanner";
import { Tabs, type TabItem } from "./ui/Tabs";
import { createAgentToken, type AgentToken } from "../lib/api";
import { apiTokensSettingsHref } from "../lib/routes";

type TabId = "mcp" | "cli" | "api";

interface ConnectAgentModalProps {
  open: boolean;
  onClose: () => void;
  teamId: string;
  /**
   * Label used in the auto-generated token name (visible later in the
   * Settings token list). Usually the team name or project name.
   */
  scopeLabel: string;
  /**
   * Called once after the backend confirms token creation and this dialog
   * shows the secret, so the parent can insert the new row into its token
   * list without a page reload.
   */
  onTokenCreated?: (token: AgentToken) => void;
  /**
   * The secret of a created token can no longer be shown here: the dialog was
   * closed or is gone (its section unmounted) before the response arrived, or
   * it is unmounted while it still shows the secret. The parent must keep the
   * secret somewhere that outlives this dialog; it is not stored anywhere else.
   * `teamId` is the team the request was made for, fixed before the request
   * started. The token may or may not have been announced through
   * `onTokenCreated` already, so the parent adds it to its list idempotently.
   */
  onSecretUnseen?: (secret: UnseenSecret) => void;
  /**
   * A create failed after the dialog was closed or unmounted. Receives the
   * team the request was made for, so the message is not taken for a failure
   * of whatever team is shown now.
   */
  onCreateFailedUnseen?: (teamId: string, message: string) => void;
}

export interface UnseenSecret {
  teamId: string;
  token: AgentToken;
  rawToken: string;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

// Minimum viable scope set for the documented happy path.
const AGENT_SCOPES = [
  "tasks:read",
  "tasks:claim",
  "tasks:comment",
  "tasks:transition",
  "tasks:update",
];

// Default token lifetime.
const TOKEN_TTL_DAYS = 90;

// How long after "Copy snippet" the raw token stays visible in the DOM
// before being replaced with placeholder bullets.
const DEFAULT_REVEAL_MASK_DELAY_MS = 30_000;
const MASK_PLACEHOLDER = "••••••••";

// Test-only override. Unit tests drive the component through userEvent
// and can't reliably mix vi.useFakeTimers with React's async effect
// queue here. Production code never calls this.
let revealMaskDelayMs = DEFAULT_REVEAL_MASK_DELAY_MS;
export function __setMaskDelayForTests(ms: number): void {
  revealMaskDelayMs = ms;
}

const TABS: TabItem[] = [
  { value: "mcp", label: "Claude Code / MCP" },
  { value: "cli", label: "CLI" },
  { value: "api", label: "curl / API" },
];

function snippetMcp(token: string): string {
  return `claude mcp add agent-tasks \\
  --scope user \\
  --env AGENT_TASKS_TOKEN="${token}" \\
  -- npx -y @agent-tasks/mcp-server`;
}

function snippetMcpHttp(token: string, apiBase: string): string {
  return `claude mcp add --transport http agent-tasks \\
  ${apiBase}/api/mcp \\
  --header "Authorization: Bearer ${token}"`;
}

function snippetCli(token: string, apiBase: string): string {
  // The CLI is not published to npm: build it from a checkout (Node 22+).
  return `git clone https://github.com/LanNguyenSi/agent-tasks.git
cd agent-tasks
npm install
npm run build --workspace=@agent-tasks/cli
export AGENT_TASKS_ENDPOINT="${apiBase}"
export AGENT_TASKS_TOKEN="${token}"
node cli/dist/index.js tasks list`;
}

function snippetCurl(token: string, apiBase: string): string {
  return `curl -H "Authorization: Bearer ${token}" \\
  ${apiBase}/api/tasks`;
}

function randomSuffix(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}

export default function ConnectAgentModal({
  open,
  onClose,
  teamId,
  scopeLabel,
  onTokenCreated,
  onSecretUnseen,
  onCreateFailedUnseen,
}: ConnectAgentModalProps) {
  const [activeTab, setActiveTab] = useState<TabId>("mcp");
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenMasked, setTokenMasked] = useState(false);
  const maskTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearMaskTimer() {
    if (maskTimerRef.current) {
      clearTimeout(maskTimerRef.current);
      maskTimerRef.current = null;
    }
  }

  // False once this dialog is gone: a create that finishes later reports to
  // the parent instead of to state nobody renders any more.
  const mountedRef = useRef(true);
  // Bumped whenever the dialog closes. A create belongs to the dialog session
  // it started in; a response that arrives in a later session (closed, or
  // closed and reopened) must not write into it.
  const sessionRef = useRef(0);
  // The created token while this dialog shows its secret, so it can be handed
  // over if the dialog is unmounted before the user closes it.
  const shownRef = useRef<UnseenSecret | null>(null);
  // Latest callbacks, for the unmount cleanup and for responses that arrive
  // after the render that started the request (no stale closure).
  const onSecretUnseenRef = useRef(onSecretUnseen);
  onSecretUnseenRef.current = onSecretUnseen;
  const onCreateFailedUnseenRef = useRef(onCreateFailedUnseen);
  onCreateFailedUnseenRef.current = onCreateFailedUnseen;

  // Reset all state when the modal closes so a fresh open starts clean.
  useEffect(() => {
    if (!open) {
      sessionRef.current += 1;
      shownRef.current = null;
      setToken(null);
      setError(null);
      setActiveTab("mcp");
      setLoading(false);
      setTokenMasked(false);
      clearMaskTimer();
    }
  }, [open]);

  // Clear any pending timer when the modal unmounts so a stale fire after
  // route change cannot setState on an unmounted tree. A secret still on
  // screen goes to the parent, which is not unmounted with this dialog.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearMaskTimer();
      const shown = shownRef.current;
      shownRef.current = null;
      if (shown) onSecretUnseenRef.current?.(shown);
    };
  }, []);

  async function handleGenerate() {
    if (loading || token) return;
    setLoading(true);
    setError(null);

    // The team and the dialog session are fixed when the request starts: the
    // response belongs to them whatever the page shows by the time it arrives.
    const createdFor = teamId;
    const session = sessionRef.current;
    const stillHere = () => mountedRef.current && sessionRef.current === session;

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = `Agent (${scopeLabel}) — ${stamp}-${randomSuffix()}`;
    const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 86_400_000).toISOString();

    try {
      const res = await createAgentToken({ teamId: createdFor, name, scopes: AGENT_SCOPES, expiresAt });
      if (stillHere()) {
        shownRef.current = { teamId: createdFor, token: res.token, rawToken: res.rawToken };
        setToken(res.rawToken);
        onTokenCreated?.(res.token);
      } else {
        onSecretUnseenRef.current?.({
          teamId: createdFor,
          token: res.token,
          rawToken: res.rawToken,
        });
      }
    } catch (err) {
      const message = (err as Error).message || "Could not generate a token.";
      if (stillHere()) setError(message);
      else onCreateFailedUnseenRef.current?.(createdFor, message);
    } finally {
      if (stillHere()) setLoading(false);
    }
  }

  function handleCopySnippet(raw: string) {
    // After the snippet has been copied to the clipboard, start the
    // mask-after-delay timer so an abandoned tab doesn't leave the token on
    // screen permanently.
    clearMaskTimer();
    maskTimerRef.current = setTimeout(() => {
      setTokenMasked(true);
      maskTimerRef.current = null;
    }, revealMaskDelayMs);
    // Perform the clipboard write.
    void navigator.clipboard.writeText(raw);
  }

  function revealToken() {
    clearMaskTimer();
    setTokenMasked(false);
  }

  const snippet = token
    ? activeTab === "mcp"
      ? snippetMcp(token)
      : activeTab === "cli"
        ? snippetCli(token, API_BASE)
        : snippetCurl(token, API_BASE)
    : "";

  const displaySnippet =
    tokenMasked && token ? snippet.split(token).join(MASK_PLACEHOLDER) : snippet;

  const verifyHint =
    activeTab === "mcp"
      ? "Restart Claude Code. Then ask it to list your agent-tasks — it should return the tasks from your team."
      : activeTab === "cli"
        ? "You should see a list of claimable tasks."
        : "You should receive a JSON response with a `tasks` array.";

  return (
    <Modal open={open} onClose={onClose} title="Connect your agent">
      {/* Scope and TTL summary visible before generation */}
      <p className="connect-agent-intro">
        Generate a token and wire up any agent client in one step.
        Paste the snippet below into your terminal.
      </p>
      <p className="connect-agent-summary">
        The token will be <strong>team-scoped</strong> (grants access to every project
        in this team), expires in {TOKEN_TTL_DAYS} days, and carries exactly these
        scopes: <code>{AGENT_SCOPES.join(" ")}</code>.
      </p>

      <Tabs
        label="Client type"
        tabs={TABS}
        value={activeTab}
        onChange={(v) => setActiveTab(v as TabId)}
        className="connect-agent-tabs"
      />

      {error && (
        <AlertBanner tone="danger" title="Could not generate token">
          {error}
        </AlertBanner>
      )}

      {!token && (
        <div className="connect-agent-generate">
          <Button
            data-testid="connect-generate-btn"
            onClick={() => void handleGenerate()}
            loading={loading}
            disabled={loading}
          >
            Generate token
          </Button>
          {loading && (
            <span className="connect-agent-generating-hint">Generating token…</span>
          )}
        </div>
      )}

      {token && (
        <>
          <pre
            data-testid="connect-snippet"
            data-token-masked={tokenMasked}
            className="connect-agent-snippet"
          >
            {displaySnippet}
          </pre>
          <div className="connect-agent-actions">
            <Button
              size="sm"
              onClick={() => handleCopySnippet(snippet)}
            >
              Copy snippet
            </Button>
            {tokenMasked && (
              <Button
                size="sm"
                variant="ghost"
                onClick={revealToken}
                data-testid="connect-reveal"
              >
                Reveal token
              </Button>
            )}
          </div>
          <p className="connect-agent-verify">
            <strong>Verify:</strong> {verifyHint}
          </p>
          {activeTab === "mcp" && token && (
            <details
              data-testid="connect-mcp-http-alt"
              className="connect-agent-http-alt"
            >
              <summary className="connect-agent-http-alt-summary">
                Running remote / headless? Use the HTTP transport instead.
              </summary>
              <p className="connect-agent-http-alt-desc">
                Remote agents that can&apos;t spawn a stdio subprocess can register
                the backend&apos;s stateless{" "}
                <a
                  href="https://github.com/LanNguyenSi/agent-tasks/tree/master/mcp-server#remote-clients-use-the-backends-apimcp-endpoint-instead"
                  target="_blank"
                  rel="noreferrer"
                  className="connect-agent-link"
                >
                  HTTP MCP endpoint
                </a>{" "}
                instead: 21 tools (the v1 alias subset), same governance, no child process.
              </p>
              <pre
                data-testid="connect-mcp-http-snippet"
                className="connect-agent-snippet connect-agent-snippet--sm"
              >
                {tokenMasked && token
                  ? snippetMcpHttp(token, API_BASE).split(token).join(MASK_PLACEHOLDER)
                  : snippetMcpHttp(token, API_BASE)}
              </pre>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void navigator.clipboard.writeText(snippetMcpHttp(token, API_BASE))}
              >
                Copy HTTP snippet
              </Button>
            </details>
          )}
          <AlertBanner tone="warning">
            This token is shown once. It has been saved to{" "}
            {/* The modal is created for a concrete team, so the link to the
                section where the token can be revoked carries it. */}
            <a href={apiTokensSettingsHref(teamId)} className="connect-agent-link">
              Team settings &rarr; API Tokens
            </a>{" "}
            where you can revoke it later -- but you cannot view the value again.
          </AlertBanner>
        </>
      )}
    </Modal>
  );
}
