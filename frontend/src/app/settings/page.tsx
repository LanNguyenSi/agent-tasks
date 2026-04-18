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
  updateDelegationSettings,
  getGithubTokenHealth,
  getAvailableScopes,
  type User,
  type Team,
  type AgentToken,
  type GithubTokenHealth,
} from "../../lib/api";
import AppHeader from "../../components/AppHeader";
import AlertBanner from "../../components/ui/AlertBanner";
import { Button } from "../../components/ui/Button";
import Card from "../../components/ui/Card";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import FormField from "../../components/ui/FormField";
import Select from "@/components/ui/Select";
import ConnectAgentModal from "../../components/ConnectAgentModal";
import ThemePreferenceField from "../../components/ThemePreferenceField";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
// Fallback used only if the backend scope endpoint fails to load. The
// canonical list now lives in `backend/src/services/scopes.ts` and is
// fetched via `GET /api/agent-tokens/scopes` — this hard-coded copy used
// to drift (it missed `github:pr_create` / `github:pr_merge` after those
// scopes landed). Kept in sync as a safety net only.
const FALLBACK_SCOPES = [
  { id: "tasks:read", label: "Read tasks" },
  { id: "tasks:create", label: "Create tasks" },
  { id: "tasks:claim", label: "Claim tasks" },
  { id: "tasks:comment", label: "Comment on tasks" },
  { id: "tasks:transition", label: "Transition tasks" },
  { id: "tasks:update", label: "Update task fields (branch, PR, result)" },
  { id: "projects:read", label: "Read projects" },
  { id: "boards:read", label: "Read boards" },
  { id: "github:pr_create", label: "Open pull requests on behalf of a team member (server-side)" },
  { id: "github:pr_merge", label: "Merge pull requests on behalf of a team member (server-side)" },
  { id: "sso:admin", label: "Manage SSO connection (team-scoped, sensitive)" },
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
  const [copyMessage, setCopyMessage] = useState<string | null>(null);

  const [showConnect, setShowConnect] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>(["tasks:read", "tasks:create", "tasks:claim"]);
  const [availableScopes, setAvailableScopes] = useState<{ id: string; label: string }[]>(FALLBACK_SCOPES);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState(false);

  const [delegation, setDelegation] = useState({
    allowAgentPrCreate: false,
    allowAgentPrMerge: false,
    allowAgentPrComment: false,
  });
  const [delegationSaving, setDelegationSaving] = useState(false);
  const [delegationSuccess, setDelegationSuccess] = useState(false);

  const [tokenHealth, setTokenHealth] = useState<GithubTokenHealth | null>(null);

  const githubConnectedNow = useMemo(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("github_connected") === "1";
  }, []);
  const docsUrl = `${API_BASE}/docs`;
  const openApiUrl = `${API_BASE}/api/openapi.json`;
  const mcpPackage = "@agent-tasks/mcp-server";
  const mcpCommand = `npx ${mcpPackage} --token <TOKEN>`;
  const setupSnippet = [
    "Agent Setup (MCP-first)",
    `MCP server: ${mcpPackage}`,
    `Quick start: ${mcpCommand}`,
    "REST fallback header: Authorization: Bearer <TOKEN>",
  ].join("\n");

  useEffect(() => {
    void (async () => {
      const me = await getCurrentUser();
      if (!me) {
        router.replace("/auth");
        return;
      }
      setUser(me);
      setDelegation({
        allowAgentPrCreate: me.allowAgentPrCreate,
        allowAgentPrMerge: me.allowAgentPrMerge,
        allowAgentPrComment: me.allowAgentPrComment,
      });

      const t = await getTeams();
      setTeams(t);

      // Pull the canonical scope list from the backend so the UI never
      // drifts. Falls back to the hard-coded list if the endpoint
      // misbehaves — the settings page stays usable even when a single
      // scope row is out of date.
      void getAvailableScopes()
        .then((scopes) => {
          if (scopes.length > 0) setAvailableScopes(scopes);
        })
        .catch(() => {
          // keep FALLBACK_SCOPES
        });

      if (t.length > 0) {
        const teamId = t[0]!.id;
        setSelectedTeamId(teamId);
        const tok = await getAgentTokens(teamId);
        setTokens(tok);
      }

      // Probe GitHub token health in the background — don't block the
      // page on a GitHub round-trip. The endpoint is cheap on a cache
      // hit; on a miss it's a single API call that takes <500ms.
      if (me.githubConnected) {
        void getGithubTokenHealth()
          .then(setTokenHealth)
          .catch(() => setTokenHealth({ state: "unknown", lastCheckedAt: null }));
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

  async function handleConfirmRevoke() {
    if (!revokeTarget) return;
    setRevoking(true);
    setError(null);
    try {
      await revokeAgentToken(revokeTarget.id);
      setTokens((prev) => prev.filter((t) => t.id !== revokeTarget.id));
      setRevokeTarget(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRevoking(false);
    }
  }

  async function handleDelegationSave() {
    setDelegationSaving(true);
    setDelegationSuccess(false);
    setError(null);
    try {
      const updated = await updateDelegationSettings(delegation);
      setUser(updated);
      setDelegationSuccess(true);
      setTimeout(() => setDelegationSuccess(false), 3000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDelegationSaving(false);
    }
  }

  async function copyToClipboard(value: string, message: string) {
    await navigator.clipboard.writeText(value);
    setCopyMessage(message);
    setTimeout(() => setCopyMessage(null), 2400);
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
    <main className="page-shell">
      <AppHeader user={user ? { login: user.login, avatarUrl: user.avatarUrl } : null} />

      <nav style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem", fontSize: "var(--text-sm)" }}>
        <a href="#account" style={{ color: "var(--muted)" }}>Account</a>
        <a href="#appearance" style={{ color: "var(--muted)" }}>Appearance</a>
        <a href="#github" style={{ color: "var(--muted)" }}>GitHub</a>
        <a href="#sso" style={{ color: "var(--muted)" }}>Enterprise SSO</a>
        <a href="#delegation" style={{ color: "var(--muted)" }}>Agent Permissions</a>
        <a href="#api-tokens" style={{ color: "var(--muted)" }}>API Tokens</a>
      </nav>

      <Card style={{ marginBottom: "var(--space-4)" }}>
        <section id="account">
          <h2 style={{ fontSize: "var(--text-base)", fontWeight: 700, marginBottom: "0.5rem" }}>Account</h2>
          <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)", marginBottom: "0.25rem" }}>Login: {user?.login}</p>
          <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)", marginBottom: "0.25rem" }}>Name: {user?.name ?? "-"}</p>
          <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>Email: {user?.email ?? "-"}</p>
        </section>
      </Card>

      <Card style={{ marginBottom: "var(--space-4)" }}>
        <section id="appearance">
          <h2 style={{ fontSize: "var(--text-base)", fontWeight: 700, marginBottom: "0.5rem" }}>Appearance</h2>
          <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)", marginBottom: "var(--space-3)" }}>
            Choose how agent-tasks looks on this device. The preference is stored locally in your browser.
          </p>
          <ThemePreferenceField />
        </section>
      </Card>

      <Card style={{ marginBottom: "var(--space-4)" }}>
        <section id="github">
          <h2 style={{ fontSize: "var(--text-base)", fontWeight: 700, marginBottom: "0.5rem" }}>GitHub Integration</h2>
          {githubConnectedNow && (
            <AlertBanner tone="success" title="Connection updated">
              GitHub connected successfully.
            </AlertBanner>
          )}
          {user?.githubConnected ? (
            tokenHealth?.state === "invalid" ? (
              <div>
                <AlertBanner tone="danger" title="GitHub token invalid">
                  Your GitHub token has been revoked or expired. Repo sync, PR
                  create/merge/comment, and the <code>ciGreen</code> transition
                  gate are currently failing for your account. Reconnect to
                  restore them.
                </AlertBanner>
                <Link
                  href="/api/auth/github/connect"
                  className="btn-primary"
                  style={{
                    display: "inline-block",
                    padding: "0.5rem 0.875rem",
                    textDecoration: "none",
                  }}
                >
                  Reconnect GitHub
                </Link>
              </div>
            ) : (
              <AlertBanner tone="success">
                GitHub is connected. Sync is available.
                {tokenHealth?.state === "healthy" && tokenHealth.lastCheckedAt && (
                  <span style={{ display: "block", color: "var(--muted)", fontSize: "var(--text-xs)", marginTop: "0.25rem" }}>
                    Token verified {formatRelativeTime(tokenHealth.lastCheckedAt)}.
                  </span>
                )}
              </AlertBanner>
            )
          ) : (
            <div>
              <AlertBanner tone="warning" title="GitHub not connected">
                No GitHub connection yet. Repository sync is disabled until you connect GitHub.
              </AlertBanner>
              <Link
                href="/api/auth/github/connect"
                className="btn-secondary"
                style={{
                  display: "inline-block",
                  padding: "0.5rem 0.875rem",
                  textDecoration: "none",
                }}
              >
                Connect GitHub
              </Link>
            </div>
          )}
        </section>
      </Card>

      <Card style={{ marginBottom: "var(--space-4)" }}>
        <section id="sso">
          <h2 style={{ fontSize: "var(--text-base)", fontWeight: 700, marginBottom: "0.5rem" }}>
            Enterprise SSO
          </h2>
          <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)", marginBottom: "0.75rem" }}>
            Configure OpenID Connect so members of your team can sign in with their company
            identity provider (Okta, Azure AD, Google Workspace, Auth0, Keycloak, and others).
            Gated by an AgentToken with the <code>sso:admin</code> scope — not by your normal
            session — so stolen browser sessions cannot touch SSO config. Generate a token
            under <a href="#api-tokens" style={{ color: "var(--link)" }}>API Tokens</a> and
            hand it out-of-band to whoever owns IdP setup.
          </p>
          <Link
            href="/settings/sso"
            className="btn-secondary"
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "0.5rem 1rem",
              borderRadius: "var(--radius-lg)",
              textDecoration: "none",
              fontWeight: 600,
            }}
          >
            Manage SSO connection
          </Link>
        </section>
      </Card>

      <Card style={{ marginBottom: "var(--space-4)" }}>
        <section id="delegation">
          <h2 style={{ fontSize: "var(--text-base)", fontWeight: 700, marginBottom: "0.5rem" }}>Agent Permissions</h2>
          <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)", marginBottom: "0.75rem" }}>
            Allow agents to perform GitHub actions on your behalf. Without explicit consent, delegation endpoints will reject requests.
          </p>
          {!user?.githubConnected && (
            <div style={{ marginBottom: "0.75rem" }}>
              <AlertBanner tone="warning">
                Connect GitHub first to enable agent delegation.
              </AlertBanner>
            </div>
          )}
          <div style={{ display: "grid", gap: "0.5rem", marginBottom: "1rem", opacity: user?.githubConnected ? 1 : 0.5, pointerEvents: user?.githubConnected ? "auto" : "none" }}>
            {([
              { key: "allowAgentPrCreate" as const, label: "Allow agents to create PRs on my behalf" },
              { key: "allowAgentPrMerge" as const, label: "Allow agents to merge PRs on my behalf" },
              { key: "allowAgentPrComment" as const, label: "Allow agents to comment on PRs on my behalf" },
            ]).map(({ key, label }) => (
              <label key={key} style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer", fontSize: "var(--text-sm)" }}>
                <input
                  type="checkbox"
                  checked={delegation[key]}
                  onChange={(e) => setDelegation((prev) => ({ ...prev, [key]: e.target.checked }))}
                />
                {label}
              </label>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <Button
              size="sm"
              disabled={!user?.githubConnected || delegationSaving}
              loading={delegationSaving}
              onClick={() => void handleDelegationSave()}
            >
              Save
            </Button>
            {delegationSuccess && (
              <span style={{ color: "var(--success)", fontSize: "var(--text-sm)" }}>Saved</span>
            )}
          </div>
        </section>
      </Card>

      <Card>
        <section id="api-tokens">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <div>
            <h2 style={{ fontSize: "var(--text-base)", fontWeight: 700 }}>API Tokens</h2>
            <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>
              Tokens are team-scoped. Create and manage them here in user settings.
            </p>
          </div>
          {teams.length > 0 && (() => {
            // Admin-only: backend `canManageTeamTokens` rejects non-admins
            // on `POST /api/agent-tokens`. Disable the buttons in the UI
            // rather than letting users click a primary CTA that 403s,
            // mirroring the gating the dashboard Connect button had before
            // the flow moved here.
            const canManage = selectedTeam?.role === "ADMIN";
            const adminTitle = canManage
              ? undefined
              : "Only team admins can generate agent tokens";
            return (
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <Button
                  onClick={() => setShowConnect(true)}
                  size="sm"
                  disabled={!canManage}
                  title={adminTitle}
                >
                  Connect an agent
                </Button>
                <Button
                  onClick={() => setShowCreate(true)}
                  size="sm"
                  variant="ghost"
                  disabled={!canManage}
                  title={adminTitle}
                >
                  Create custom token
                </Button>
              </div>
            );
          })()}
        </div>

        {teams.length === 0 ? (
          <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>
            No team found yet. Create a team first to generate API tokens.
          </p>
        ) : (
          <div style={{ marginBottom: "1rem" }}>
            <FormField label="Team">
              <Select
                value={selectedTeamId}
                onChange={(v) => {
                  setSelectedTeamId(v);
                  void loadTokens(v);
                }}
                options={teams.map((team) => ({ value: team.id, label: team.name }))}
                style={{ width: "100%", maxWidth: "320px" }}
              />
            </FormField>
            <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", marginTop: "0.25rem" }}>
              Active team: {selectedTeam?.name}
            </p>
          </div>
        )}

        <AlertBanner tone="info" title="Agent setup (2 steps)">
          <ol style={{ margin: "0 0 0.625rem 1.1rem", padding: 0 }}>
            <li>Create a token and pass it to the agent.</li>
            <li>
              Connect the agent to the MCP server — this is the supported
              agent interface. The REST API stays available as a fallback.
            </li>
          </ol>
          <div style={{ display: "grid", gap: "0.5rem", marginBottom: "0.4rem" }}>
            <label style={{ display: "grid", gap: "0.25rem" }}>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>MCP server package</span>
              <span style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
                <code style={{ display: "block", background: "var(--surface)", padding: "0.5rem 0.625rem", borderRadius: "6px", border: "1px solid var(--border)", color: "var(--text)", fontSize: "var(--text-xs)", wordBreak: "break-all", flex: "1 1 380px" }}>
                  {mcpPackage}
                </code>
                <Button variant="ghost" size="sm" onClick={() => void copyToClipboard(mcpPackage, "Package name copied.")}>Copy</Button>
              </span>
            </label>
            <label style={{ display: "grid", gap: "0.25rem" }}>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>Quick start command</span>
              <span style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
                <code style={{ display: "block", background: "var(--surface)", padding: "0.5rem 0.625rem", borderRadius: "6px", border: "1px solid var(--border)", color: "var(--text)", fontSize: "var(--text-xs)", wordBreak: "break-all", flex: "1 1 380px" }}>
                  {mcpCommand}
                </code>
                <Button variant="ghost" size="sm" onClick={() => void copyToClipboard(mcpCommand, "Command copied.")}>Copy</Button>
              </span>
            </label>
          </div>
          <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", margin: 0 }}>
            Or add the server to your MCP client config (Claude Code, Cursor, …).
            REST fallback header: <code>Authorization: Bearer &lt;TOKEN&gt;</code>
          </p>
          <Button variant="ghost" size="sm" style={{ marginTop: "0.55rem" }} onClick={() => void copyToClipboard(setupSnippet, "Setup info copied.")}>Copy all setup info</Button>
          {copyMessage && (
            <p style={{ color: "var(--text)", fontSize: "var(--text-xs)", marginTop: "0.4rem" }}>
              {copyMessage}
            </p>
          )}
        </AlertBanner>

        <AlertBanner tone="info" title="Developer docs (REST API)">
          <p style={{ margin: "0 0 0.5rem 0", color: "var(--muted)", fontSize: "var(--text-xs)" }}>
            For frontend, CLI, or integrations that talk to the REST API
            directly. Agents should use the MCP server above.
          </p>
          <div style={{ display: "grid", gap: "0.5rem" }}>
            <label style={{ display: "grid", gap: "0.25rem" }}>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>Swagger docs</span>
              <span style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
                <code style={{ display: "block", background: "var(--surface)", padding: "0.5rem 0.625rem", borderRadius: "6px", border: "1px solid var(--border)", color: "var(--text)", fontSize: "var(--text-xs)", wordBreak: "break-all", flex: "1 1 380px" }}>
                  {docsUrl}
                </code>
                <Button variant="ghost" size="sm" onClick={() => void copyToClipboard(docsUrl, "Swagger link copied.")}>Copy</Button>
              </span>
            </label>
            <label style={{ display: "grid", gap: "0.25rem" }}>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>OpenAPI JSON</span>
              <span style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
                <code style={{ display: "block", background: "var(--surface)", padding: "0.5rem 0.625rem", borderRadius: "6px", border: "1px solid var(--border)", color: "var(--text)", fontSize: "var(--text-xs)", wordBreak: "break-all", flex: "1 1 380px" }}>
                  {openApiUrl}
                </code>
                <Button variant="ghost" size="sm" onClick={() => void copyToClipboard(openApiUrl, "OpenAPI link copied.")}>Copy</Button>
              </span>
            </label>
          </div>
        </AlertBanner>

        {error && !showCreate && (
          <AlertBanner tone="danger" title="Action failed">
            {error}
          </AlertBanner>
        )}

        {newToken && (
          <AlertBanner tone="success" title="Token created - visible once">
            <code style={{ display: "block", background: "var(--surface)", padding: "0.625rem 0.75rem", borderRadius: "6px", fontFamily: "monospace", fontSize: "var(--text-sm)", wordBreak: "break-all", color: "var(--text)" }}>
              {newToken}
            </code>
            <Button variant="secondary" size="sm" style={{ marginTop: "0.625rem" }} onClick={() => void copyToClipboard(newToken, "Token copied.")}>Copy</Button>
            <Button variant="ghost" size="sm" style={{ marginTop: "0.625rem", marginLeft: "0.5rem" }} onClick={() => setNewToken(null)}>Dismiss</Button>
          </AlertBanner>
        )}

        {showCreate && teams.length > 0 && (
          <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "10px", padding: "1rem", marginBottom: "1rem" }}>
            <h3 style={{ fontSize: "var(--text-base)", fontWeight: 600, marginBottom: "1rem" }}>Create Agent Token</h3>
            <form onSubmit={(e) => void handleCreate(e)}>
              <div style={{ marginBottom: "0.875rem" }}>
                <FormField label="Token name">
                  <input value={tokenName} onChange={(e) => setTokenName(e.target.value)} placeholder="e.g. ci-bot" required style={{ width: "100%", display: "block" }} />
                </FormField>
              </div>
              <div style={{ marginBottom: "1rem" }}>
                <FormField label="Scopes">
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                    {availableScopes.map((scope) => (
                      <label key={scope.id} style={{ display: "flex", alignItems: "center", gap: "0.375rem", cursor: "pointer", fontSize: "var(--text-sm)" }}>
                        <input
                          type="checkbox"
                          checked={selectedScopes.includes(scope.id)}
                          onChange={(e) => {
                            if (e.target.checked) setSelectedScopes((s) => [...s, scope.id]);
                            else setSelectedScopes((s) => s.filter((x) => x !== scope.id));
                          }}
                        />
                        <span style={{ background: "var(--border)", padding: "0.125rem 0.5rem", borderRadius: "4px", fontFamily: "monospace", fontSize: "var(--text-xs)" }}>{scope.id}</span>
                      </label>
                    ))}
                  </div>
                </FormField>
              </div>
              {error && (
                <AlertBanner tone="danger" title="Failed to create token">
                  {error}
                </AlertBanner>
              )}
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <Button type="submit" disabled={creating} loading={creating} size="sm">Create</Button>
                <Button variant="ghost" size="sm" type="button" onClick={() => setShowCreate(false)}>Cancel</Button>
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
                  <p style={{ fontWeight: 600, fontSize: "var(--text-sm)", marginBottom: "0.25rem" }}>{token.name}</p>
                  <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap" }}>
                    {token.scopes.map((s) => (
                      <span key={s} style={{ background: "var(--border)", padding: "0 0.375rem", borderRadius: "4px", fontFamily: "monospace", fontSize: "var(--text-xs)", color: "var(--muted)" }}>{s}</span>
                    ))}
                  </div>
                </div>
                <Button variant="outline-danger" size="sm" onClick={() => setRevokeTarget({ id: token.id, name: token.name })}>Revoke</Button>
              </div>
            ))}
          </div>
        ))}
        </section>
      </Card>

      <ConfirmDialog
        open={Boolean(revokeTarget)}
        title="Revoke API token?"
        message={revokeTarget ? `The token "${revokeTarget.name}" will stop working immediately.` : ""}
        confirmLabel="Revoke token"
        cancelLabel="Keep token"
        tone="danger"
        busy={revoking}
        onConfirm={() => void handleConfirmRevoke()}
        onCancel={() => {
          if (revoking) return;
          setRevokeTarget(null);
        }}
      />

      {selectedTeamId && selectedTeam && (
        <ConnectAgentModal
          open={showConnect}
          onClose={() => setShowConnect(false)}
          teamId={selectedTeamId}
          scopeLabel={selectedTeam.name}
          onTokenCreated={(token) => {
            // Optimistic insert into the visible token list so the user
            // sees the new row immediately without a page reload. The
            // server-side create is done by the modal; this just mirrors
            // it in the table below.
            setTokens((prev) => [...prev, token]);
          }}
        />
      )}
    </main>
  );
}
