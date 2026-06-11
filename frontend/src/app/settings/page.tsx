"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import AlertBanner from "../../components/ui/AlertBanner";
import { Button } from "../../components/ui/Button";
import Card from "../../components/ui/Card";
import CollapsibleSection from "../../components/ui/CollapsibleSection";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import { CopyableCode } from "../../components/ui/CopyableCode";
import EmptyState from "../../components/ui/EmptyState";
import FormField from "../../components/ui/FormField";
import { FullPageLoader } from "../../components/ui/FullPageLoader";
import Modal from "../../components/ui/Modal";
import { PageHeader } from "../../components/ui/PageHeader";
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

// Fallback used only if the backend scope endpoint fails to load.
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

// Sensitive scopes receive a tinted background to make their severity visible.
const SENSITIVE_SCOPES = new Set(["sso:admin", "github:pr_merge"]);

type TokenRecord = AgentToken;

// One-time token reveal: mask after a delay so an abandoned tab does not
// leave the secret on screen indefinitely.
const REVEAL_MASK_DELAY_MS = 30_000;

// Section ids for the sticky side-nav anchors.
const SECTIONS = [
  { id: "account", label: "Account" },
  { id: "appearance", label: "Appearance" },
  { id: "github", label: "GitHub" },
  { id: "sso", label: "Enterprise SSO" },
  { id: "delegation", label: "Agent Permissions" },
  { id: "api-tokens", label: "API Tokens" },
];

export default function SettingsPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  const [tokens, setTokens] = useState<TokenRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokenMasked, setTokenMasked] = useState(false);
  const maskTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeSection, setActiveSection] = useState<string>("account");

  const [showConnect, setShowConnect] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([
    "tasks:read",
    "tasks:create",
    "tasks:claim",
  ]);
  const [availableScopes, setAvailableScopes] =
    useState<{ id: string; label: string }[]>(FALLBACK_SCOPES);
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

      if (me.githubConnected) {
        void getGithubTokenHealth()
          .then(setTokenHealth)
          .catch(() =>
            setTokenHealth({ state: "unknown", lastCheckedAt: null }),
          );
      }

      setLoading(false);
    })();
  }, [router]);

  // Scroll spy: update active section based on the section currently in view.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
          }
        }
      },
      { rootMargin: "-40% 0px -55% 0px", threshold: 0 },
    );

    const ids = SECTIONS.map((s) => s.id);
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [loading]);

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
      const result = await createAgentToken({
        teamId: selectedTeamId,
        name: tokenName.trim(),
        scopes: selectedScopes,
      });
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

  function revealNewToken() {
    if (maskTimerRef.current) {
      clearTimeout(maskTimerRef.current);
      maskTimerRef.current = null;
    }
    setTokenMasked(false);
  }

  function startNewTokenMask() {
    if (maskTimerRef.current) clearTimeout(maskTimerRef.current);
    maskTimerRef.current = setTimeout(() => {
      setTokenMasked(true);
      maskTimerRef.current = null;
    }, REVEAL_MASK_DELAY_MS);
  }

  useEffect(() => {
    if (!newToken) {
      setTokenMasked(false);
      if (maskTimerRef.current) {
        clearTimeout(maskTimerRef.current);
        maskTimerRef.current = null;
      }
      return;
    }
    setTokenMasked(false);
    maskTimerRef.current = setTimeout(() => {
      setTokenMasked(true);
      maskTimerRef.current = null;
    }, REVEAL_MASK_DELAY_MS);
    return () => {
      if (maskTimerRef.current) {
        clearTimeout(maskTimerRef.current);
        maskTimerRef.current = null;
      }
    };
  }, [newToken]);

  if (loading) {
    return <FullPageLoader label="Loading settings…" />;
  }

  const selectedTeam = teams.find((t) => t.id === selectedTeamId);
  const isDelegationDirty = user
    ? delegation.allowAgentPrCreate !== user.allowAgentPrCreate ||
      delegation.allowAgentPrMerge !== user.allowAgentPrMerge ||
      delegation.allowAgentPrComment !== user.allowAgentPrComment
    : false;

  return (
    <main className="page-shell">
      <PageHeader title="Settings" />

      <div className="settings-layout">
        {/* Sticky side-nav: hidden under 1000px via CSS */}
        <aside className="settings-side-nav" aria-label="Settings sections">
          <nav>
            <p className="settings-side-nav-group-label">Account &amp; Appearance</p>
            <a
              href="#account"
              className={`settings-side-nav-link${activeSection === "account" ? " settings-side-nav-link--active" : ""}`}
            >
              Account
            </a>
            <a
              href="#appearance"
              className={`settings-side-nav-link${activeSection === "appearance" ? " settings-side-nav-link--active" : ""}`}
            >
              Appearance
            </a>
            <p className="settings-side-nav-group-label">Integrations</p>
            <a
              href="#github"
              className={`settings-side-nav-link${activeSection === "github" ? " settings-side-nav-link--active" : ""}`}
            >
              GitHub
            </a>
            <a
              href="#sso"
              className={`settings-side-nav-link${activeSection === "sso" ? " settings-side-nav-link--active" : ""}`}
            >
              Enterprise SSO
            </a>
            <a
              href="#delegation"
              className={`settings-side-nav-link${activeSection === "delegation" ? " settings-side-nav-link--active" : ""}`}
            >
              Agent Permissions
            </a>
            <p className="settings-side-nav-group-label">Developer</p>
            <a
              href="#api-tokens"
              className={`settings-side-nav-link${activeSection === "api-tokens" ? " settings-side-nav-link--active" : ""}`}
            >
              API Tokens
            </a>
          </nav>
        </aside>

        <div className="settings-content">
          {/* Group 1: Account & Appearance */}
          <div className="settings-section-group">
            <p className="settings-group-eyebrow">Account &amp; Appearance</p>

            <Card>
              <section id="account">
                <h2 className="settings-section-heading">Account</h2>
                <dl className="settings-account-list">
                  <dt>Login</dt>
                  <dd>{user?.login}</dd>
                  <dt>Name</dt>
                  <dd>{user?.name ?? "Not set"}</dd>
                  <dt>Email</dt>
                  <dd>{user?.email ?? "Not set"}</dd>
                </dl>
              </section>
            </Card>

            <Card>
              <section id="appearance">
                <h2 className="settings-section-heading">Appearance</h2>
                <p className="settings-section-desc">
                  Choose how agent-tasks looks on this device. The preference is stored
                  locally in your browser.
                </p>
                <ThemePreferenceField />
              </section>
            </Card>
          </div>

          {/* Group 2: Integrations */}
          <div className="settings-section-group">
            <p className="settings-group-eyebrow">Integrations</p>

            <Card>
              <section id="github">
                <h2 className="settings-section-heading">GitHub Integration</h2>
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
                      <Button href="/api/auth/github/connect" variant="secondary">
                        Reconnect GitHub
                      </Button>
                    </div>
                  ) : tokenHealth?.state === "unknown" ? (
                    <div>
                      <AlertBanner tone="info">
                        GitHub is connected. Could not verify token health just now.
                        {tokenHealth.lastCheckedAt && (
                          <span className="settings-github-check-time">
                            Last checked {formatRelativeTime(tokenHealth.lastCheckedAt)}.
                          </span>
                        )}
                      </AlertBanner>
                    </div>
                  ) : (
                    <AlertBanner tone="success">
                      GitHub is connected. Sync is available.
                      {tokenHealth?.state === "healthy" && tokenHealth.lastCheckedAt && (
                        <span className="settings-github-check-time">
                          Token verified {formatRelativeTime(tokenHealth.lastCheckedAt)}.
                        </span>
                      )}
                    </AlertBanner>
                  )
                ) : (
                  <div>
                    <AlertBanner tone="warning" title="GitHub not connected">
                      No GitHub connection yet. Repository sync is disabled until you
                      connect GitHub.
                    </AlertBanner>
                    <Button href="/api/auth/github/connect" variant="secondary">
                      Connect GitHub
                    </Button>
                  </div>
                )}
              </section>
            </Card>

            <Card>
              <section id="sso">
                <h2 className="settings-section-heading">Enterprise SSO</h2>
                <p className="settings-section-desc">
                  Configure OpenID Connect so members of your team can sign in with their
                  company identity provider (Okta, Azure AD, Google Workspace, Auth0,
                  Keycloak, and others). Gated by an AgentToken with the{" "}
                  <code>sso:admin</code> scope -- not by your normal session -- so stolen
                  browser sessions cannot touch SSO config. Generate a token under{" "}
                  <a href="#api-tokens" className="settings-inline-link">
                    API Tokens
                  </a>{" "}
                  and hand it out-of-band to whoever owns IdP setup.
                </p>
                <Button href="/settings/sso" variant="secondary">
                  Manage SSO connection
                </Button>
              </section>
            </Card>

            <Card>
              <section id="delegation">
                <h2 className="settings-section-heading">Agent Permissions</h2>
                <p className="settings-section-desc">
                  Allow agents to perform GitHub actions on your behalf. Without explicit
                  consent, agent requests are rejected.
                </p>
                {!user?.githubConnected && (
                  <AlertBanner tone="warning">
                    Connect GitHub first to enable agent permissions.
                  </AlertBanner>
                )}
                <div
                  className="settings-delegation-grid"
                  /* dynamic: opacity/pointerEvents depend on runtime githubConnected state */
                  /* eslint-disable-next-line no-restricted-syntax */
                  style={{
                    opacity: user?.githubConnected ? 1 : 0.5, /* dynamic: auth state */
                    pointerEvents: user?.githubConnected ? "auto" : "none", /* dynamic: auth state */
                  }}
                >
                  {(
                    [
                      {
                        key: "allowAgentPrCreate" as const,
                        label: "Allow agents to create PRs on my behalf",
                      },
                      {
                        key: "allowAgentPrMerge" as const,
                        label: "Allow agents to merge PRs on my behalf",
                      },
                      {
                        key: "allowAgentPrComment" as const,
                        label: "Allow agents to comment on PRs on my behalf",
                      },
                    ] as const
                  ).map(({ key, label }) => (
                    <label key={key} className="settings-delegation-row">
                      <input
                        type="checkbox"
                        checked={delegation[key]}
                        disabled={!user?.githubConnected}
                        onChange={(e) =>
                          setDelegation((prev) => ({
                            ...prev,
                            [key]: e.target.checked,
                          }))
                        }
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
                <div className="settings-delegation-footer">
                  <Button
                    size="sm"
                    disabled={!user?.githubConnected || delegationSaving || !isDelegationDirty}
                    loading={delegationSaving}
                    onClick={() => void handleDelegationSave()}
                  >
                    Save
                  </Button>
                  {delegationSuccess ? (
                    <span className="settings-delegation-status settings-delegation-status--saved">
                      Saved
                    </span>
                  ) : isDelegationDirty ? (
                    <span className="settings-delegation-status">Unsaved changes</span>
                  ) : null}
                </div>
              </section>
            </Card>
          </div>

          {/* Group 3: API Tokens */}
          <div className="settings-section-group">
            <p className="settings-group-eyebrow">Developer</p>

            <Card>
              <section id="api-tokens">
                <div className="settings-tokens-header">
                  <div>
                    <h2 className="settings-section-heading">API Tokens</h2>
                    <p className="settings-section-desc">
                      Tokens are team-scoped. Create and manage them here in user settings.
                    </p>
                  </div>
                  {teams.length > 0 &&
                    (() => {
                      const canManage = selectedTeam?.role === "ADMIN";
                      const adminTitle = canManage
                        ? undefined
                        : "Only team admins can generate agent tokens";
                      return (
                        <div className="settings-tokens-actions">
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

                {teams.length > 0 && (
                  <div className="settings-team-select">
                    <FormField label="Team">
                      <Select
                        value={selectedTeamId}
                        onChange={(v) => {
                          setSelectedTeamId(v);
                          void loadTokens(v);
                        }}
                        options={teams.map((team) => ({
                          value: team.id,
                          label: team.name,
                        }))}
                      />
                    </FormField>
                  </div>
                )}

                {/* Documentation banners collapsed by default so the token list
                    is visible above the fold on a standard 1440x900 viewport. */}
                <CollapsibleSection title="Agent setup (2 steps)">
                  <div className="settings-docs-block">
                    <ol className="settings-docs-steps">
                      <li>Create a token and pass it to the agent.</li>
                      <li>
                        Connect the agent to the MCP server -- this is the supported
                        agent interface. The REST API stays available as a fallback.
                      </li>
                    </ol>
                    <CopyableCode
                      value={mcpPackage}
                      label="MCP server package"
                    />
                    <CopyableCode
                      value={mcpCommand}
                      label="Quick start command"
                    />
                    <p className="settings-docs-hint">
                      Or add the server to your MCP client config (Claude Code, Cursor, …).
                      REST fallback header: <code>Authorization: Bearer &lt;TOKEN&gt;</code>
                    </p>
                  </div>
                </CollapsibleSection>

                <CollapsibleSection title="Developer docs (REST API)">
                  <div className="settings-docs-block">
                    <p className="settings-docs-hint">
                      For frontend, CLI, or integrations that talk to the REST API
                      directly. Agents should use the MCP server above.
                    </p>
                    <CopyableCode value={docsUrl} label="Swagger docs" />
                    <CopyableCode value={openApiUrl} label="OpenAPI JSON" />
                  </div>
                </CollapsibleSection>

                {error && !showCreate && (
                  <AlertBanner tone="danger" title="Action failed">
                    {error}
                  </AlertBanner>
                )}

                {newToken && (
                  <AlertBanner tone="success" title="Token created (shown once)">
                    <CopyableCode
                      value={newToken}
                      masked={tokenMasked}
                      onCopy={startNewTokenMask}
                    />
                    {tokenMasked && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={revealNewToken}
                        className="settings-token-reveal"
                      >
                        Reveal
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setNewToken(null)}
                      className="settings-token-reveal"
                    >
                      Dismiss
                    </Button>
                  </AlertBanner>
                )}

                {teams.length === 0 ? (
                  <EmptyState
                    icon="box"
                    title="No team found yet"
                    description="Create a team first to generate API tokens."
                    dashed
                  />
                ) : tokens.length === 0 ? (
                  <EmptyState
                    icon="box"
                    title="No tokens yet"
                    description="Generate a token to connect an agent or integration."
                    dashed
                    action={
                      selectedTeam?.role === "ADMIN" ? (
                        <Button
                          size="sm"
                          onClick={() => setShowConnect(true)}
                        >
                          Connect an agent
                        </Button>
                      ) : undefined
                    }
                  />
                ) : (
                  <div className="settings-token-list">
                    {tokens.map((token, i) => (
                      <div
                        key={token.id}
                        className={`settings-token-row${i < tokens.length - 1 ? " settings-token-row--bordered" : ""}`}
                      >
                        <div>
                          <p className="settings-token-name">{token.name}</p>
                          <div className="settings-token-scopes">
                            {token.scopes.map((s) => (
                              <code key={s} className="settings-token-scope">
                                {s}
                              </code>
                            ))}
                          </div>
                          <p className="settings-token-meta">
                            Created {formatRelativeTime(token.createdAt)}
                            {token.lastUsedAt
                              ? ` · last used ${formatRelativeTime(token.lastUsedAt)}`
                              : " · never used"}
                            {token.expiresAt
                              ? ` · expires ${new Date(token.expiresAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`
                              : ""}
                          </p>
                        </div>
                        <Button
                          variant="outline-danger"
                          size="sm"
                          onClick={() =>
                            setRevokeTarget({ id: token.id, name: token.name })
                          }
                        >
                          Revoke
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </Card>
          </div>
        </div>
      </div>

      {/* Create token modal */}
      <Modal
        open={showCreate && teams.length > 0}
        onClose={() => setShowCreate(false)}
        title="Create Agent Token"
      >
        <form onSubmit={(e) => void handleCreate(e)}>
          <div className="settings-create-token-form">
            <FormField label="Token name">
              <input
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
                placeholder="e.g. ci-bot"
                required
                className="settings-input"
              />
            </FormField>
          </div>
          <div className="settings-scope-grid">
            <FormField label="Scopes">
              {availableScopes.map((scope) => {
                const isSensitive = SENSITIVE_SCOPES.has(scope.id);
                return (
                  <label
                    key={scope.id}
                    className={`settings-scope-row${isSensitive ? " settings-scope-row--sensitive" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedScopes.includes(scope.id)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedScopes((s) => [...s, scope.id]);
                        } else {
                          setSelectedScopes((s) => s.filter((x) => x !== scope.id));
                        }
                      }}
                    />
                    <div className="settings-scope-info">
                      <code className="settings-scope-id">{scope.id}</code>
                      <span className="settings-scope-label">{scope.label}</span>
                    </div>
                  </label>
                );
              })}
            </FormField>
            {selectedScopes.length === 0 && (
              <p className="settings-scope-hint">Select at least one scope.</p>
            )}
          </div>
          {error && (
            <AlertBanner tone="danger" title="Failed to create token">
              {error}
            </AlertBanner>
          )}
          <div className="settings-modal-actions">
            <Button
              type="submit"
              disabled={creating || selectedScopes.length === 0}
              loading={creating}
              size="sm"
            >
              Create
            </Button>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => setShowCreate(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={Boolean(revokeTarget)}
        title="Revoke API token?"
        message={
          revokeTarget
            ? `The token "${revokeTarget.name}" will stop working immediately.`
            : ""
        }
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
            setTokens((prev) => [...prev, token]);
          }}
        />
      )}
    </main>
  );
}
