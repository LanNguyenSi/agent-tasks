"use client";

import { useEffect, useRef, useState } from "react";
import Modal from "./ui/Modal";
import { Button } from "./ui/Button";
import AlertBanner from "./ui/AlertBanner";
import { createAgentToken, type AgentToken } from "../lib/api";

type TabId = "mcp" | "cli" | "api";

interface ConnectAgentModalProps {
  open: boolean;
  onClose: () => void;
  teamId: string;
  /**
   * Label used in the auto-generated token name (visible later in the
   * Settings token list). Usually the team name or project name — the
   * token itself is always team-scoped regardless. Keeps the row in the
   * token list findable: "Agent (TeamFoo) — 2026-04-14T18-30-15-ab12cd34".
   */
  scopeLabel: string;
  /**
   * Called once after the backend confirms token creation, so the parent
   * can insert the new row into its token list without a page reload.
   */
  onTokenCreated?: (token: AgentToken) => void;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

// Minimum viable scope set for the documented happy path: discover a task,
// claim it, comment/transition it, update its branch/PR fields. We deliberately
// do NOT include `tasks:create` (agents consume a backlog, they do not author
// it via this one-click flow) or `projects:read` (backend authorizes via team
// membership, not this scope — verified in backend/src/routes/tasks.ts).
// Aligns with least-privilege and matches Settings-flow defaults.
const AGENT_SCOPES = [
  "tasks:read",
  "tasks:claim",
  "tasks:comment",
  "tasks:transition",
  "tasks:update",
];

// Default token lifetime. A frictionless one-click path is the exact place
// where a forever-token is the wrong default — 90 days forces rotation
// without being disruptive.
const TOKEN_TTL_DAYS = 90;

function snippetMcp(token: string): string {
  return `claude mcp add agent-tasks \\
  --scope user \\
  --env AGENT_TASKS_TOKEN="${token}" \\
  -- npx -y @agent-tasks/mcp-server`;
}

function snippetCli(token: string, apiBase: string): string {
  return `export AGENT_TASKS_ENDPOINT="${apiBase}"
export AGENT_TASKS_TOKEN="${token}"
npx -y agent-tasks-cli tasks list`;
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

export default function ConnectAgentModal({ open, onClose, teamId, scopeLabel, onTokenCreated }: ConnectAgentModalProps) {
  const [activeTab, setActiveTab] = useState<TabId>("mcp");
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);

  // Hard guard against issuing more than one POST per "open" intent. The
  // `cancelled` flag in the effect only stops a stale response from writing
  // state — it does NOT cancel the in-flight HTTP request (fetch here is not
  // aborted). StrictMode double-invoke plus rapid open/close could still
  // persist two tokens. The ref is keyed by `open` + props; once a request
  // has fired for a given intent, we refuse to fire a second one until the
  // modal closes.
  const inflightKey = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      setToken(null);
      setError(null);
      setCopyMessage(null);
      setActiveTab("mcp");
      setLoading(false);
      inflightKey.current = null;
      return;
    }

    const key = `${teamId}::${scopeLabel}`;
    if (inflightKey.current === key) {
      // Already fired for this open; do nothing.
      return;
    }
    inflightKey.current = key;

    let cancelled = false;
    setLoading(true);
    setError(null);

    // Timestamp (seconds) + random suffix so repeat opens never collide,
    // even within a single second or under StrictMode double invoke.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = `Agent (${scopeLabel}) — ${stamp}-${randomSuffix()}`;
    const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 86_400_000).toISOString();

    createAgentToken({ teamId, name, scopes: AGENT_SCOPES, expiresAt })
      .then((res) => {
        if (cancelled) return;
        setToken(res.rawToken);
        onTokenCreated?.(res.token);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        // Friendly message for the common non-admin case. The backend
        // returns "Only team admins can create agent tokens" on 403
        // (backend/src/routes/agent-tokens.ts), which is already clear,
        // but we surface it through a tone-appropriate banner below.
        setError(err.message || "Could not generate a token.");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // Intentionally excluding `token`, `loading`, and `onTokenCreated` —
    // the first two are written by this effect and including them would
    // cause spurious re-runs; the callback is a stable external reference
    // that should never retrigger token generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, teamId, scopeLabel]);

  async function copy(value: string, message: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyMessage(message);
      setTimeout(() => setCopyMessage(null), 2400);
    } catch {
      setCopyMessage("Copy failed — select and copy manually.");
    }
  }

  const snippet = token
    ? activeTab === "mcp"
      ? snippetMcp(token)
      : activeTab === "cli"
        ? snippetCli(token, API_BASE)
        : snippetCurl(token, API_BASE)
    : "";

  const verifyHint =
    activeTab === "mcp"
      ? "Restart Claude Code. Then ask it to list your agent-tasks — it should return the tasks from your team."
      : activeTab === "cli"
        ? "You should see a list of claimable tasks."
        : "You should receive a JSON response with a `tasks` array.";

  return (
    <Modal open={open} onClose={onClose} title="Connect your agent">
      <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)", marginBottom: "0.5rem" }}>
        Generate a token and wire up any agent client in one step. Paste the snippet below into your terminal.
      </p>
      <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", marginBottom: "1rem" }}>
        The token is <strong>team-scoped</strong> (grants access to every project in this team), expires in {TOKEN_TTL_DAYS} days, and carries exactly these scopes: <code>{AGENT_SCOPES.join(" ")}</code>.
      </p>

      <div
        role="tablist"
        aria-label="Client type"
        style={{ display: "flex", gap: "0.25rem", borderBottom: "1px solid var(--border)", marginBottom: "0.875rem" }}
      >
        <TabButton id="mcp" active={activeTab === "mcp"} onClick={() => setActiveTab("mcp")} recommended>
          Claude Code / MCP
        </TabButton>
        <TabButton id="cli" active={activeTab === "cli"} onClick={() => setActiveTab("cli")}>
          CLI
        </TabButton>
        <TabButton id="api" active={activeTab === "api"} onClick={() => setActiveTab("api")}>
          curl / API
        </TabButton>
      </div>

      {error && (
        <AlertBanner tone="danger" title="Could not generate token">
          {error}
        </AlertBanner>
      )}

      {loading && !token && (
        <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>Generating token…</p>
      )}

      {token && (
        <>
          <pre
            data-testid="connect-snippet"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "8px",
              padding: "0.875rem 1rem",
              fontSize: "var(--text-xs)",
              fontFamily: "monospace",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              color: "var(--text)",
              margin: 0,
              marginBottom: "0.625rem",
            }}
          >
            {snippet}
          </pre>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.75rem", flexWrap: "wrap" }}>
            <Button size="sm" onClick={() => void copy(snippet, "Snippet copied.")}>
              Copy snippet
            </Button>
            {copyMessage && (
              <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>{copyMessage}</span>
            )}
          </div>
          <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", marginBottom: "0.75rem" }}>
            <strong style={{ color: "var(--text)" }}>Verify:</strong> {verifyHint}
          </p>
          <AlertBanner tone="warning">
            This token is shown once. It has been saved to{" "}
            <a href="/settings#api-tokens" style={{ color: "var(--link)" }}>
              Settings → API Tokens
            </a>{" "}
            where you can revoke it later — but you cannot view the value again.
          </AlertBanner>
        </>
      )}
    </Modal>
  );
}

function TabButton({
  id,
  active,
  onClick,
  recommended,
  children,
}: {
  id: string;
  active: boolean;
  onClick: () => void;
  recommended?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={`connect-tab-${id}`}
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        borderBottom: active ? "2px solid var(--primary)" : "2px solid transparent",
        color: active ? "var(--text)" : "var(--muted)",
        padding: "0.5rem 0.875rem",
        fontSize: "var(--text-sm)",
        fontWeight: active ? 600 : 500,
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4rem",
      }}
    >
      {children}
      {recommended && (
        <span
          style={{
            background: "var(--primary)",
            color: "var(--bg)",
            fontSize: "0.65rem",
            fontWeight: 600,
            padding: "0.1rem 0.4rem",
            borderRadius: "999px",
            textTransform: "uppercase",
            letterSpacing: "0.02em",
          }}
        >
          Recommended
        </span>
      )}
    </button>
  );
}
