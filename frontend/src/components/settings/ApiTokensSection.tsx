"use client";

// API tokens section of Team settings: the token list, the Connect an agent
// flow, and the create / rename / revoke modals. Owns the token list and every
// modal's state; the team itself (list + selected id) is owned by the page so
// the rest of the page follows it. Moved out of the old combined /settings
// page: token behaviour is unchanged.

import { useEffect, useRef, useState } from "react";
import {
  createAgentToken,
  revokeAgentToken,
  renameAgentToken,
  getAvailableScopes,
  type Team,
  type AgentToken,
} from "../../lib/api";
import AlertBanner from "../ui/AlertBanner";
import { Button } from "../ui/Button";
import Card from "../ui/Card";
import CollapsibleSection from "../ui/CollapsibleSection";
import ConfirmDialog from "../ui/ConfirmDialog";
import { CopyableCode } from "../ui/CopyableCode";
import EmptyState from "../ui/EmptyState";
import FormField from "../ui/FormField";
import Modal from "../ui/Modal";
import ConnectAgentModal from "../ConnectAgentModal";
import { formatRelativeTime } from "./formatRelativeTime";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

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

interface ApiTokensSectionProps {
  /** All teams of the caller (drives the empty state and the admin check). */
  teams: Team[];
  /**
   * The current team's id. The header switcher owns team switching; the page
   * remounts this section (`key`) with the new team's tokens when it changes.
   */
  selectedTeamId: string;
  /** Tokens of `selectedTeamId`, loaded by the page before first render. */
  initialTokens: TokenRecord[];
}

export default function ApiTokensSection({
  teams,
  selectedTeamId,
  initialTokens,
}: ApiTokensSectionProps) {
  const [tokens, setTokens] = useState<TokenRecord[]>(initialTokens);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokenMasked, setTokenMasked] = useState(false);
  const maskTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);

  const docsUrl = `${API_BASE}/docs`;
  const openApiUrl = `${API_BASE}/api/openapi.json`;
  const mcpPackage = "@agent-tasks/mcp-server";
  const mcpCommand = `npx ${mcpPackage} --token <TOKEN>`;

  useEffect(() => {
    void getAvailableScopes()
      .then((scopes) => {
        if (scopes.length > 0) setAvailableScopes(scopes);
      })
      .catch(() => {
        // keep FALLBACK_SCOPES
      });
  }, []);

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

  async function handleConfirmRename(e: React.FormEvent) {
    e.preventDefault();
    if (!renameTarget || !renameValue.trim()) return;
    setRenaming(true);
    setError(null);
    try {
      const updated = await renameAgentToken(renameTarget.id, renameValue.trim());
      setTokens((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      setRenameTarget(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRenaming(false);
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

  const selectedTeam = teams.find((t) => t.id === selectedTeamId);
  // Single source of truth for the three duplicated "is the caller a team
  // admin for the selected team" checks below (connect/create buttons, the
  // empty-state action, and each token row's rename/revoke gating).
  const isTeamAdmin = selectedTeam?.role === "ADMIN";

  return (
    <>
      <Card>
        <section id="api-tokens">
          <div className="settings-tokens-header">
            <div>
              <h2 className="settings-section-heading">API Tokens</h2>
              <p className="settings-section-desc">
                {selectedTeam && (
                  <>
                    API tokens for <strong>{selectedTeam.name}</strong>.{" "}
                  </>
                )}
                Tokens are team-scoped. Create and manage them here in team settings.
              </p>
            </div>
            {teams.length > 0 &&
              (() => {
                const adminTitle = isTeamAdmin
                  ? undefined
                  : "Only team admins can generate API tokens";
                return (
                  <div className="settings-tokens-actions">
                    <Button
                      onClick={() => setShowConnect(true)}
                      size="sm"
                      disabled={!isTeamAdmin}
                      title={adminTitle}
                    >
                      Connect an agent
                    </Button>
                    <Button
                      onClick={() => setShowCreate(true)}
                      size="sm"
                      variant="ghost"
                      disabled={!isTeamAdmin}
                      title={adminTitle}
                    >
                      Create custom token
                    </Button>
                  </div>
                );
              })()}
          </div>

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

          {error && !showCreate && !renameTarget && (
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
                isTeamAdmin ? (
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
              {tokens.map((token, i) => {
                const renameTitle = isTeamAdmin
                  ? undefined
                  : "Only team admins can rename API tokens";
                const revokeTitle = isTeamAdmin
                  ? undefined
                  : "Only team admins can revoke API tokens";
                return (
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
                    <div className="settings-tokens-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!isTeamAdmin}
                        title={renameTitle}
                        onClick={() => {
                          setError(null);
                          setRenameTarget({ id: token.id, name: token.name });
                          setRenameValue(token.name);
                        }}
                      >
                        Rename
                      </Button>
                      <Button
                        variant="outline-danger"
                        size="sm"
                        disabled={!isTeamAdmin}
                        title={revokeTitle}
                        onClick={() =>
                          setRevokeTarget({ id: token.id, name: token.name })
                        }
                      >
                        Revoke
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </Card>

      {/* Create token modal */}
      <Modal
        open={showCreate && teams.length > 0}
        onClose={() => setShowCreate(false)}
        title="Create API Token"
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

      {/* Rename token modal */}
      <Modal
        open={Boolean(renameTarget)}
        onClose={() => {
          if (renaming) return;
          setError(null);
          setRenameTarget(null);
        }}
        title={renameTarget ? `Rename "${renameTarget.name}"` : "Rename API Token"}
      >
        <form onSubmit={(e) => void handleConfirmRename(e)}>
          <div className="settings-create-token-form">
            <FormField label="Token name">
              <input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder="e.g. ci-bot"
                required
                maxLength={100}
                className="settings-input"
                autoFocus
              />
            </FormField>
          </div>
          {error && (
            <AlertBanner tone="danger" title="Failed to rename token">
              {error}
            </AlertBanner>
          )}
          <div className="settings-modal-actions">
            <Button
              type="submit"
              disabled={renaming || !renameValue.trim()}
              loading={renaming}
              size="sm"
            >
              Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              disabled={renaming}
              onClick={() => {
                setError(null);
                setRenameTarget(null);
              }}
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
    </>
  );
}
