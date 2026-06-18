"use client";

import { useEffect, useRef, useState } from "react";
import Modal from "./ui/Modal";
import { Button } from "./ui/Button";
import AlertBanner from "./ui/AlertBanner";
import { Tabs, type TabItem } from "./ui/Tabs";
import { createAgentToken, type AgentToken } from "../lib/api";

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
   * Called once after the backend confirms token creation, so the parent
   * can insert the new row into its token list without a page reload.
   */
  onTokenCreated?: (token: AgentToken) => void;
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
  return `export AGENT_TASKS_ENDPOINT="${apiBase}"
export AGENT_TASKS_TOKEN="${token}"
npx -y @agent-tasks/cli tasks list`;
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

  // Reset all state when the modal closes so a fresh open starts clean.
  useEffect(() => {
    if (!open) {
      setToken(null);
      setError(null);
      setActiveTab("mcp");
      setLoading(false);
      setTokenMasked(false);
      clearMaskTimer();
    }
  }, [open]);

  // Clear any pending timer when the modal unmounts so a stale fire after
  // route change cannot setState on an unmounted tree.
  useEffect(() => {
    return () => clearMaskTimer();
  }, []);

  async function handleGenerate() {
    if (loading || token) return;
    setLoading(true);
    setError(null);

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = `Agent (${scopeLabel}) — ${stamp}-${randomSuffix()}`;
    const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 86_400_000).toISOString();

    try {
      const res = await createAgentToken({ teamId, name, scopes: AGENT_SCOPES, expiresAt });
      setToken(res.rawToken);
      onTokenCreated?.(res.token);
    } catch (err) {
      setError((err as Error).message || "Could not generate a token.");
    } finally {
      setLoading(false);
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
            <a href="/settings#api-tokens" className="connect-agent-link">
              Settings &rarr; API Tokens
            </a>{" "}
            where you can revoke it later -- but you cannot view the value again.
          </AlertBanner>
        </>
      )}
    </Modal>
  );
}
