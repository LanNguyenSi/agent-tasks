"use client";

import { useEffect, useState } from "react";
import { getCurrentUser, getTeams, getAgentTokens, createAgentToken, revokeAgentToken, type User, type Team, type AgentToken } from "../../../lib/api";

const ALL_SCOPES = [
  { id: "tasks:read", label: "Read tasks" },
  { id: "tasks:create", label: "Create tasks" },
  { id: "tasks:claim", label: "Claim tasks" },
  { id: "tasks:comment", label: "Comment on tasks" },
  { id: "tasks:transition", label: "Transition tasks" },
  { id: "projects:read", label: "Read projects" },
  { id: "boards:read", label: "Read boards" },
];

type TokenRecord = AgentToken;

export default function TokensPage() {
  const [user, setUser] = useState<User | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  const [tokens, setTokens] = useState<TokenRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [newToken, setNewToken] = useState<string | null>(null);

  // Create token form
  const [showCreate, setShowCreate] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>(["tasks:read", "tasks:create", "tasks:claim"]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const me = await getCurrentUser();
      if (!me) { window.location.href = "/"; return; }
      setUser(me);
      const t = await getTeams();
      if (t.length === 0) { window.location.href = "/onboarding"; return; }
      setTeams(t);
      const teamId = t[0]!.id;
      setSelectedTeamId(teamId);
      const tok = await getAgentTokens(teamId);
      setTokens(tok);
      setLoading(false);
    })();
  }, []);

  async function loadTokens(teamId: string) {
    const tok = await getAgentTokens(teamId);
    setTokens(tok);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!tokenName.trim() || !selectedTeamId) return;
    setCreating(true);
    setError(null);
    try {
      const result = await createAgentToken({ teamId: selectedTeamId, name: tokenName.trim(), scopes: selectedScopes });
      setNewToken(result.rawToken);
      setTokens((prev) => [...prev, result.token]);
      setShowCreate(false);
      setTokenName("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(tokenId: string) {
    if (!confirm("Revoke this token? This cannot be undone.")) return;
    await revokeAgentToken(tokenId);
    setTokens((prev) => prev.filter((t) => t.id !== tokenId));
  }

  if (loading) {
    return <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}><p style={{ color: "var(--muted)" }}>Loading…</p></main>;
  }

  const selectedTeam = teams.find((t) => t.id === selectedTeamId);

  return (
    <main style={{ padding: "1.5rem", maxWidth: "900px", margin: "0 auto", minHeight: "100vh" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem", borderBottom: "1px solid var(--border)", paddingBottom: "1rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <a href="/teams" style={{ color: "var(--primary)", fontWeight: 700 }}>agent-tasks</a>
          <span style={{ color: "var(--muted)" }}>/</span>
          <span style={{ color: "var(--muted)" }}>Agent Tokens</span>
        </div>
        <span style={{ color: "var(--muted)", fontSize: "0.875rem" }}>{user?.login}</span>
      </header>

      {/* New token banner */}
      {newToken && (
        <div style={{ background: "#0d2a1a", border: "1px solid var(--success)", borderRadius: "10px", padding: "1.25rem", marginBottom: "1.5rem" }}>
          <p style={{ fontWeight: 600, color: "var(--success)", marginBottom: "0.5rem" }}>✅ Token created — copy it now, it will not be shown again!</p>
          <code style={{ display: "block", background: "var(--surface)", padding: "0.625rem 0.75rem", borderRadius: "6px", fontFamily: "monospace", fontSize: "0.875rem", wordBreak: "break-all", color: "var(--text)" }}>
            {newToken}
          </code>
          <button onClick={() => { void navigator.clipboard.writeText(newToken); }} style={{ marginTop: "0.625rem", background: "var(--success)", color: "white", border: "none", borderRadius: "6px", padding: "0.375rem 0.875rem", cursor: "pointer", fontSize: "0.8125rem", fontFamily: "inherit" }}>Copy to Clipboard</button>
          <button onClick={() => setNewToken(null)} style={{ marginTop: "0.625rem", marginLeft: "0.5rem", background: "transparent", color: "var(--muted)", border: "1px solid var(--border)", borderRadius: "6px", padding: "0.375rem 0.875rem", cursor: "pointer", fontSize: "0.8125rem", fontFamily: "inherit" }}>Dismiss</button>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
        <div>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 700 }}>Agent Tokens</h1>
          <p style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>
            Tokens for team: {selectedTeam?.name}
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          style={{ background: "var(--primary)", color: "white", border: "none", borderRadius: "8px", padding: "0.5rem 1.25rem", fontWeight: 600, cursor: "pointer", fontSize: "0.875rem", fontFamily: "inherit" }}
        >
          + New Token
        </button>
      </div>

      {showCreate && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "10px", padding: "1.25rem", marginBottom: "1.25rem" }}>
          <h3 style={{ fontSize: "0.9375rem", fontWeight: 600, marginBottom: "1rem" }}>Create Agent Token</h3>
          <form onSubmit={(e) => void handleCreate(e)}>
            <div style={{ marginBottom: "0.875rem" }}>
              <label style={{ display: "block", color: "var(--muted)", fontSize: "0.75rem", marginBottom: "0.25rem" }}>Token name</label>
              <input value={tokenName} onChange={(e) => setTokenName(e.target.value)} placeholder="e.g. lava-agent" required style={{ width: "100%", display: "block" }} />
            </div>
            <div style={{ marginBottom: "1rem" }}>
              <label style={{ display: "block", color: "var(--muted)", fontSize: "0.75rem", marginBottom: "0.5rem" }}>Scopes</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                {ALL_SCOPES.map((scope) => (
                  <label key={scope.id} style={{ display: "flex", alignItems: "center", gap: "0.375rem", cursor: "pointer", fontSize: "0.8125rem" }}>
                    <input
                      type="checkbox"
                      checked={selectedScopes.includes(scope.id)}
                      onChange={(e) => {
                        if (e.target.checked) setSelectedScopes((s) => [...s, scope.id]);
                        else setSelectedScopes((s) => s.filter((x) => x !== scope.id));
                      }}
                    />
                    <span style={{ background: "var(--border)", padding: "0.125rem 0.5rem", borderRadius: "4px", fontFamily: "monospace", fontSize: "0.75rem" }}>{scope.id}</span>
                    <span style={{ color: "var(--muted)" }}>{scope.label}</span>
                  </label>
                ))}
              </div>
            </div>
            {error && <p style={{ color: "var(--danger)", fontSize: "0.8125rem", marginBottom: "0.75rem" }}>{error}</p>}
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button type="submit" disabled={creating} style={{ background: "var(--primary)", color: "white", border: "none", borderRadius: "6px", padding: "0.5rem 1rem", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{creating ? "Creating…" : "Create"}</button>
              <button type="button" onClick={() => setShowCreate(false)} style={{ background: "transparent", color: "var(--muted)", border: "1px solid var(--border)", borderRadius: "6px", padding: "0.5rem 1rem", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {tokens.length === 0 ? (
        <div style={{ textAlign: "center", padding: "3rem", border: "1px dashed var(--border)", borderRadius: "10px", color: "var(--muted)" }}>
          No tokens yet. Agents need tokens to access the API.
        </div>
      ) : (
        <div style={{ border: "1px solid var(--border)", borderRadius: "10px", overflow: "hidden" }}>
          {tokens.map((token, i) => (
            <div key={token.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.875rem 1rem", borderBottom: i < tokens.length - 1 ? "1px solid var(--border)" : "none" }}>
              <div>
                <p style={{ fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.25rem" }}>{token.name}</p>
                <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap" }}>
                  {token.scopes.map((s) => (
                    <span key={s} style={{ background: "var(--border)", padding: "0 0.375rem", borderRadius: "4px", fontFamily: "monospace", fontSize: "0.7rem", color: "var(--muted)" }}>{s}</span>
                  ))}
                </div>
                {token.lastUsedAt && <p style={{ color: "var(--muted)", fontSize: "0.75rem", marginTop: "0.25rem" }}>Last used: {new Date(token.lastUsedAt).toLocaleDateString()}</p>}
              </div>
              <button onClick={() => void handleRevoke(token.id)} style={{ background: "transparent", color: "var(--danger)", border: "1px solid var(--danger)", borderRadius: "6px", padding: "0.25rem 0.75rem", cursor: "pointer", fontSize: "0.8125rem", fontFamily: "inherit" }}>Revoke</button>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
