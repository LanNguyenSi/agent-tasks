"use client";

import { useState } from "react";
import AlertBanner from "../../../components/ui/AlertBanner";
import { Button } from "../../../components/ui/Button";
import Card from "../../../components/ui/Card";
import ConfirmDialog from "../../../components/ui/ConfirmDialog";
import FormField from "../../../components/ui/FormField";
import { PageHeader } from "../../../components/ui/PageHeader";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/**
 * SSO config is token-gated: an AgentToken with the `sso:admin` scope is
 * required, not a normal session. This page NEVER relies on session cookies;
 * the token lives only in React state for the current tab. It is not stored
 * in localStorage -- close the tab and you have to paste it again.
 *
 * Flow:
 *   1. User pastes the token -- we call /api/sso/whoami to resolve team + existing config
 *   2. We render the edit form pre-filled (secret is never returned)
 *   3. PUT/DELETE go through the same token
 */

interface WhoamiResponse {
  team: { id: string; name: string; slug: string };
  connection: SsoConnection | null;
}

interface SsoConnection {
  id: string;
  teamId: string;
  displayName: string;
  issuer: string;
  clientId: string;
  emailDomains: string[];
  autoProvision: boolean;
  enabled: boolean;
}

async function ssoFetch<T>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export default function SsoSettingsPage() {
  const [token, setToken] = useState("");
  const [authorized, setAuthorized] = useState<WhoamiResponse | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [displayName, setDisplayName] = useState("");
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [emailDomains, setEmailDomains] = useState("");
  const [autoProvision, setAutoProvision] = useState(true);
  const [enabled, setEnabled] = useState(true);

  const callbackUrl = authorized
    ? `${API_BASE}/api/auth/sso/${authorized.team.slug}/callback`
    : "";

  async function handleAuthorize(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setAuthorizing(true);
    try {
      const result = await ssoFetch<WhoamiResponse>("/api/sso/whoami", token);
      setAuthorized(result);
      if (result.connection) {
        setDisplayName(result.connection.displayName);
        setIssuer(result.connection.issuer);
        setClientId(result.connection.clientId);
        setClientSecret("");
        setEmailDomains(result.connection.emailDomains.join(", "));
        setAutoProvision(result.connection.autoProvision);
        setEnabled(result.connection.enabled);
      }
    } catch (err) {
      setError((err as Error).message);
      setAuthorized(null);
    } finally {
      setAuthorizing(false);
    }
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!authorized) return;
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      if (!clientSecret && authorized.connection) {
        throw new Error(
          "Client secret is required. Paste it again -- for security it is never returned after saving.",
        );
      }
      const domains = emailDomains
        .split(/[\s,]+/)
        .map((d) => d.trim())
        .filter(Boolean);
      const body = await ssoFetch<{ connection: SsoConnection }>(
        `/api/teams/${authorized.team.id}/sso`,
        token,
        {
          method: "PUT",
          body: JSON.stringify({
            displayName,
            issuer,
            clientId,
            clientSecret,
            emailDomains: domains,
            autoProvision,
            enabled,
          }),
        },
      );
      setAuthorized({ ...authorized, connection: body.connection });
      setClientSecret("");
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!authorized?.connection) return;
    setError(null);
    setDeleting(true);
    try {
      await ssoFetch(`/api/teams/${authorized.team.id}/sso`, token, {
        method: "DELETE",
      });
      setAuthorized({ ...authorized, connection: null });
      setDisplayName("");
      setIssuer("");
      setClientId("");
      setClientSecret("");
      setEmailDomains("");
      setDeleteConfirmOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  function handleLock() {
    setToken("");
    setAuthorized(null);
    setDisplayName("");
    setIssuer("");
    setClientId("");
    setClientSecret("");
    setEmailDomains("");
    setSaved(false);
    setError(null);
  }

  return (
    <main className="page-shell page-shell--narrow">
      <PageHeader
        breadcrumb={
          <a href="/settings" className="settings-breadcrumb">
            Settings
          </a>
        }
        title="Enterprise SSO (OIDC)"
      />

      <p className="settings-section-desc">
        Configure your team&apos;s identity provider. This page is gated by a dedicated
        AgentToken with the <code>sso:admin</code> scope -- not by your normal session --
        so that accidental or stolen browser sessions cannot touch SSO configuration.
        Generate a token under Settings &rarr; API Tokens, hand it out-of-band to whoever
        owns your IdP setup, and revoke it when done.
      </p>

      {!authorized && (
        <Card>
          <form onSubmit={(event) => void handleAuthorize(event)}>
            <FormField label="AgentToken (sso:admin scope)">
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="agt_..."
                required
                className="settings-input"
              />
            </FormField>
            {error && (
              <AlertBanner tone="danger" title="Error">
                {error}
              </AlertBanner>
            )}
            <Button type="submit" disabled={authorizing || !token} loading={authorizing}>
              Unlock SSO settings
            </Button>
          </form>
        </Card>
      )}

      {authorized && (
        <>
          <AlertBanner tone="info" title={`Unlocked for team: ${authorized.team.name}`}>
            <div className="settings-sso-lock-row">
              <span>
                Token is held in memory only -- close the tab or click &quot;Lock&quot; to
                clear it.
              </span>
              <Button type="button" variant="secondary" onClick={handleLock}>
                Lock
              </Button>
            </div>
          </AlertBanner>

          <Card>
            <form onSubmit={(event) => void handleSave(event)}>
              <FormField label="Display name">
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Acme Okta"
                  required
                  className="settings-input"
                />
              </FormField>

              <FormField label="Issuer URL">
                <input
                  type="url"
                  value={issuer}
                  onChange={(event) => setIssuer(event.target.value)}
                  placeholder="https://acme.okta.com"
                  required
                  className="settings-input"
                />
              </FormField>

              <FormField label="Client ID">
                <input
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                  required
                  className="settings-input"
                />
              </FormField>

              <FormField
                label={
                  authorized.connection
                    ? "Client secret (re-enter to update)"
                    : "Client secret"
                }
              >
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                  required={!authorized.connection}
                  placeholder={authorized.connection ? "••••••••" : ""}
                  className="settings-input"
                />
              </FormField>

              <FormField label="Email domains (comma or space separated)">
                <input
                  value={emailDomains}
                  onChange={(event) => setEmailDomains(event.target.value)}
                  placeholder="acme.com, acme.co.uk"
                  className="settings-input"
                />
              </FormField>

              <FormField label="Redirect URI (configure in your IdP)">
                <input value={callbackUrl} readOnly className="settings-input" />
              </FormField>

              <label className="settings-delegation-row">
                <input
                  type="checkbox"
                  checked={autoProvision}
                  onChange={(event) => setAutoProvision(event.target.checked)}
                />
                <span>Auto-provision new users on first login</span>
              </label>

              <label className="settings-delegation-row">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                />
                <span>Enabled</span>
              </label>

              {error && (
                <AlertBanner tone="danger" title="Error">
                  {error}
                </AlertBanner>
              )}
              {saved && (
                <AlertBanner tone="success" title="Saved">
                  SSO connection saved. Users matching the email domains will now see a
                  one-click login button.
                </AlertBanner>
              )}

              <div className="settings-modal-actions">
                <Button type="submit" disabled={saving} loading={saving}>
                  {authorized.connection ? "Update connection" : "Create connection"}
                </Button>
                {authorized.connection && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setDeleteConfirmOpen(true)}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </form>
          </Card>
        </>
      )}

      <ConfirmDialog
        open={deleteConfirmOpen}
        title="Remove SSO connection?"
        message="This removes the SSO connection for this team. Existing sessions stay valid."
        confirmLabel="Remove"
        cancelLabel="Keep"
        tone="danger"
        busy={deleting}
        onConfirm={() => void handleDelete()}
        onCancel={() => setDeleteConfirmOpen(false)}
      />
    </main>
  );
}
