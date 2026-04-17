"use client";

import { useState } from "react";
import Link from "next/link";
import AlertBanner from "../../../components/ui/AlertBanner";
import { Button } from "../../../components/ui/Button";
import Card from "../../../components/ui/Card";
import FormField from "../../../components/ui/FormField";
import ThemeCorner from "../../../components/ThemeCorner";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/**
 * SSO config is token-gated: an AgentToken with the `sso:admin` scope is
 * required, not a normal session. This page NEVER relies on session cookies;
 * the token lives only in React state for the current tab. It is not stored
 * in localStorage — close the tab and you have to paste it again.
 *
 * Flow:
 *   1. User pastes the token → we call /api/sso/whoami to resolve team + existing config
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
    throw new Error(body.message || `Request failed (${res.status})`);
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
          "Client secret is required. Paste it again — for security it is never returned after saving.",
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
    if (!confirm("Remove the SSO connection for this team? Existing sessions stay valid.")) return;
    setError(null);
    try {
      await ssoFetch(`/api/teams/${authorized.team.id}/sso`, token, { method: "DELETE" });
      setAuthorized({ ...authorized, connection: null });
      setDisplayName("");
      setIssuer("");
      setClientId("");
      setClientSecret("");
      setEmailDomains("");
    } catch (err) {
      setError((err as Error).message);
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
    <>
    <ThemeCorner />
    <main style={{ maxWidth: "720px", margin: "0 auto", padding: "var(--space-6) var(--space-4)" }}>
      <div style={{ marginBottom: "var(--space-4)" }}>
        <Link href="/settings" style={{ color: "var(--muted)", fontSize: "var(--text-sm)", textDecoration: "none" }}>
          ← Settings
        </Link>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700, marginTop: "var(--space-2)" }}>Enterprise SSO (OIDC)</h1>
        <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>
          Configure your team&apos;s identity provider. This page is gated by a dedicated
          AgentToken with the <code>sso:admin</code> scope — not by your normal session —
          so that accidental or stolen browser sessions cannot touch SSO configuration.
          Generate a token under Settings → API Tokens, hand it out-of-band to whoever
          owns your IdP setup, and revoke it when done.
        </p>
      </div>

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
                style={{ width: "100%", display: "block" }}
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
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-2)" }}>
              <span>
                Token is held in memory only — close the tab or click &quot;Lock&quot; to
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
                  style={{ width: "100%", display: "block" }}
                />
              </FormField>

              <FormField label="Issuer URL">
                <input
                  type="url"
                  value={issuer}
                  onChange={(event) => setIssuer(event.target.value)}
                  placeholder="https://acme.okta.com"
                  required
                  style={{ width: "100%", display: "block" }}
                />
              </FormField>

              <FormField label="Client ID">
                <input
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                  required
                  style={{ width: "100%", display: "block" }}
                />
              </FormField>

              <FormField label={authorized.connection ? "Client secret (re-enter to update)" : "Client secret"}>
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                  required={!authorized.connection}
                  placeholder={authorized.connection ? "••••••••" : ""}
                  style={{ width: "100%", display: "block" }}
                />
              </FormField>

              <FormField label="Email domains (comma or space separated)">
                <input
                  value={emailDomains}
                  onChange={(event) => setEmailDomains(event.target.value)}
                  placeholder="acme.com, acme.co.uk"
                  style={{ width: "100%", display: "block" }}
                />
              </FormField>

              <FormField label="Redirect URI (configure in your IdP)">
                <input value={callbackUrl} readOnly style={{ width: "100%", display: "block" }} />
              </FormField>

              <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-2)" }}>
                <input
                  type="checkbox"
                  checked={autoProvision}
                  onChange={(event) => setAutoProvision(event.target.checked)}
                />
                Auto-provision new users on first login
              </label>

              <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                />
                Enabled
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

              <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
                <Button type="submit" disabled={saving} loading={saving}>
                  {authorized.connection ? "Update connection" : "Create connection"}
                </Button>
                {authorized.connection && (
                  <Button type="button" variant="secondary" onClick={() => void handleDelete()}>
                    Remove
                  </Button>
                )}
              </div>
            </form>
          </Card>
        </>
      )}
    </main>
    </>
  );
}
