"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  getCurrentUser,
  getTeams,
  getAgentTokens,
  createAgentToken,
  revokeAgentToken,
  type User,
  type Team,
  type AgentToken,
} from "../../lib/api";
import AppHeader from "../../components/AppHeader";

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

export default function SettingsPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  const [tokens, setTokens] = useState<TokenRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [newToken, setNewToken] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>(["tasks:read", "tasks:create", "tasks:claim"]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const githubConnectedNow = useMemo(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("github_connected") === "1";
  }, []);

  useEffect(() => {
    void (async () => {
      const me = await getCurrentUser();
      if (!me) {
        router.replace("/");
        return;
      }
      setUser(me);

      const t = await getTeams();
      setTeams(t);

      if (t.length > 0) {
        const teamId = t[0]!.id;
        setSelectedTeamId(teamId);
        const tok = await getAgentTokens(teamId);
        setTokens(tok);
      }

      setLoading(false);
    })();
  }, [router]);

  async function loadTokens(teamId: string) {
    setError(null);
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
    return (
      <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: "var(--muted)" }}>Loading…</p>
      </main>
    );
  }

  const selectedTeam = teams.find((t) => t.id === selectedTeamId);

  return (
    <main style={{ padding: "1.5rem", maxWidth: "960px", margin: "0 auto", minHeight: "100vh" }}>
      <AppHeader user={user ? { login: user.login, avatarUrl: user.avatarUrl } : null} />

      <nav style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem", fontSize: "0.82rem" }}>
        <a href="#account" style={{ color: "var(--muted)" }}>Account</a>
        <a href="#github" style={{ color: "var(--muted)" }}>GitHub</a>
        <a href="#api-tokens" style={{ color: "var(--muted)" }}>API Tokens</a>
      </nav>

      <section id="account" style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "10px", padding: "1rem", marginBottom: "1rem" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "0.5rem" }}>Account</h2>
        <p style={{ color: "var(--muted)", fontSize: "0.875rem", marginBottom: "0.25rem" }}>Login: {user?.login}</p>
        <p style={{ color: "var(--muted)", fontSize: "0.875rem", marginBottom: "0.25rem" }}>Name: {user?.name ?? "-"}</p>
        <p style={{ color: "var(--muted)", fontSize: "0.875rem" }}>E-Mail: {user?.email ?? "-"}</p>
      </section>

      <section id="github" style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "10px", padding: "1rem", marginBottom: "1rem" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "0.5rem" }}>GitHub Integration</h2>
        {githubConnectedNow && (
          <div style={{ background: "#0d2a1a", border: "1px solid var(--success)", borderRadius: "8px", padding: "0.625rem", marginBottom: "0.75rem", color: "var(--success)", fontSize: "0.875rem" }}>
            GitHub erfolgreich verbunden.
          </div>
        )}
        {user?.githubConnected ? (
          <p style={{ color: "var(--success)", fontSize: "0.875rem" }}>GitHub ist verbunden. Sync ist verfügbar.</p>
        ) : (
          <div>
            <p style={{ color: "var(--muted)", fontSize: "0.875rem", marginBottom: "0.75rem" }}>
              Noch keine GitHub-Verbindung. Ohne Verbindung ist kein Repository-Sync möglich.
            </p>
            <Link
              href="/api/auth/github/connect"
              style={{
                display: "inline-block",
                background: "#0f172a",
                color: "white",
                borderRadius: "8px",
                padding: "0.5rem 0.875rem",
                textDecoration: "none",
                fontWeight: 600,
                fontSize: "0.875rem",
              }}
            >
              GitHub verbinden
            </Link>
          </div>
        )}
      </section>

      <section id="api-tokens" style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "10px", padding: "1rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <div>
            <h2 style={{ fontSize: "1rem", fontWeight: 700 }}>API Tokens</h2>
            <p style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>
              Tokens sind teamgebunden. Erstelle sie hier in deinen User Settings.
            </p>
          </div>
          {teams.length > 0 && (
            <button
              onClick={() => setShowCreate(true)}
              style={{ background: "var(--primary)", color: "white", border: "none", borderRadius: "8px", padding: "0.5rem 1.25rem", fontWeight: 600, cursor: "pointer", fontSize: "0.875rem", fontFamily: "inherit" }}
            >
              + New Token
            </button>
          )}
        </div>

        {teams.length === 0 ? (
          <p style={{ color: "var(--muted)", fontSize: "0.875rem" }}>
            Noch kein Team vorhanden. Erstelle zuerst ein Team, um API-Tokens zu erzeugen.
          </p>
        ) : (
          <div style={{ marginBottom: "1rem" }}>
            <label style={{ display: "block", color: "var(--muted)", fontSize: "0.75rem", marginBottom: "0.25rem" }}>Team</label>
            <select
              value={selectedTeamId}
              onChange={(e) => {
                const next = e.target.value;
                setSelectedTeamId(next);
                void loadTokens(next);
              }}
              style={{ width: "100%", maxWidth: "320px" }}
            >
              {teams.map((team) => (
                <option key={team.id} value={team.id}>{team.name}</option>
              ))}
            </select>
            <p style={{ color: "var(--muted)", fontSize: "0.75rem", marginTop: "0.25rem" }}>
              Aktives Team: {selectedTeam?.name}
            </p>
          </div>
        )}

        {newToken && (
          <div style={{ background: "#0d2a1a", border: "1px solid var(--success)", borderRadius: "10px", padding: "1rem", marginBottom: "1rem" }}>
            <p style={{ fontWeight: 600, color: "var(--success)", marginBottom: "0.5rem" }}>Token erstellt — einmalig sichtbar:</p>
            <code style={{ display: "block", background: "var(--surface)", padding: "0.625rem 0.75rem", borderRadius: "6px", fontFamily: "monospace", fontSize: "0.875rem", wordBreak: "break-all", color: "var(--text)" }}>
              {newToken}
            </code>
            <button onClick={() => { void navigator.clipboard.writeText(newToken); }} style={{ marginTop: "0.625rem", background: "var(--success)", color: "white", border: "none", borderRadius: "6px", padding: "0.375rem 0.875rem", cursor: "pointer", fontSize: "0.8125rem", fontFamily: "inherit" }}>Copy</button>
            <button onClick={() => setNewToken(null)} style={{ marginTop: "0.625rem", marginLeft: "0.5rem", background: "transparent", color: "var(--muted)", border: "1px solid var(--border)", borderRadius: "6px", padding: "0.375rem 0.875rem", cursor: "pointer", fontSize: "0.8125rem", fontFamily: "inherit" }}>Dismiss</button>
          </div>
        )}

        {showCreate && teams.length > 0 && (
          <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "10px", padding: "1rem", marginBottom: "1rem" }}>
            <h3 style={{ fontSize: "0.9375rem", fontWeight: 600, marginBottom: "1rem" }}>Create Agent Token</h3>
            <form onSubmit={(e) => void handleCreate(e)}>
              <div style={{ marginBottom: "0.875rem" }}>
                <label style={{ display: "block", color: "var(--muted)", fontSize: "0.75rem", marginBottom: "0.25rem" }}>Token name</label>
                <input value={tokenName} onChange={(e) => setTokenName(e.target.value)} placeholder="e.g. ci-bot" required style={{ width: "100%", display: "block" }} />
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

        {teams.length > 0 && (tokens.length === 0 ? (
          <div style={{ textAlign: "center", padding: "2rem", border: "1px dashed var(--border)", borderRadius: "10px", color: "var(--muted)" }}>
            No tokens yet.
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
                </div>
                <button onClick={() => void handleRevoke(token.id)} style={{ background: "transparent", color: "var(--danger)", border: "1px solid var(--danger)", borderRadius: "6px", padding: "0.25rem 0.75rem", cursor: "pointer", fontSize: "0.8125rem", fontFamily: "inherit" }}>Revoke</button>
              </div>
            ))}
          </div>
        ))}
      </section>
    </main>
  );
}
