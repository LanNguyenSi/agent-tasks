"use client";

import { useEffect, useState } from "react";
import Modal from "./ui/Modal";
import { Button } from "./ui/Button";
import AlertBanner from "./ui/AlertBanner";
import { createAgentToken } from "../lib/api";

type TabId = "mcp" | "cli" | "api";

interface ConnectAgentModalProps {
  open: boolean;
  onClose: () => void;
  teamId: string;
  projectName: string;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

// Scopes covering the full agent happy-path: discover, claim, work, transition.
const AGENT_SCOPES = [
  "projects:read",
  "tasks:read",
  "tasks:create",
  "tasks:claim",
  "tasks:comment",
  "tasks:transition",
  "tasks:update",
];

function snippetMcp(token: string): string {
  return `claude mcp add agent-tasks \\
  --scope user \\
  --env AGENT_TASKS_TOKEN="${token}" \\
  -- npx -y @agent-tasks/mcp-server`;
}

function snippetCli(token: string): string {
  return `export AGENT_TASKS_TOKEN="${token}"
npx -y @agent-tasks/cli tasks list`;
}

function snippetCurl(token: string): string {
  return `curl -H "Authorization: Bearer ${token}" \\
  ${API_BASE}/api/tasks`;
}

export default function ConnectAgentModal({ open, onClose, teamId, projectName }: ConnectAgentModalProps) {
  const [activeTab, setActiveTab] = useState<TabId>("mcp");
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      // Reset on close so the next open starts clean.
      setToken(null);
      setError(null);
      setCopyMessage(null);
      setActiveTab("mcp");
      setLoading(false);
      return;
    }

    // Each open generates exactly one token. The `cancelled` flag drops
    // any in-flight response if the modal closes (or the props change)
    // before the request resolves — prevents a stale token from being
    // written into state after unmount and keeps the request count
    // to one per open.
    let cancelled = false;
    setLoading(true);
    setError(null);

    // Include seconds to disambiguate repeat opens on the same day —
    // the AgentToken table should not accumulate rows with identical names.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = `Agent (${projectName}) — ${stamp}`;

    createAgentToken({ teamId, name, scopes: AGENT_SCOPES })
      .then((res) => {
        if (cancelled) return;
        setToken(res.rawToken);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // Intentionally excluding `token` and `loading` — they are written
    // by this effect, so including them would cause spurious re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, teamId, projectName]);

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
        ? snippetCli(token)
        : snippetCurl(token)
    : "";

  const verifyHint =
    activeTab === "mcp"
      ? "Restart Claude Code. Then ask it to list your agent-tasks — it should return the tasks from this project."
      : activeTab === "cli"
        ? "You should see a JSON list of claimable tasks."
        : "You should receive a JSON response with a `tasks` array.";

  return (
    <Modal open={open} onClose={onClose} title="Connect your agent">
      <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)", marginBottom: "1rem" }}>
        Generate a token and wire up any agent client to <strong>{projectName}</strong> in one step.
        Paste the snippet below into your terminal — no Settings round-trip needed.
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
