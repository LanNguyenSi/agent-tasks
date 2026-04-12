"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  getCurrentUser,
  getTeams,
  getTeamSsoConnection,
  upsertTeamSsoConnection,
  deleteTeamSsoConnection,
  type Team,
  type SsoConnection,
} from "../../../lib/api";
import AppHeader from "../../../components/AppHeader";
import AlertBanner from "../../../components/ui/AlertBanner";
import { Button } from "../../../components/ui/Button";
import Card from "../../../components/ui/Card";
import FormField from "../../../components/ui/FormField";
import Select from "@/components/ui/Select";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export default function SsoSettingsPage() {
  const router = useRouter();
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState<string>("");
  const [connection, setConnection] = useState<SsoConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [displayName, setDisplayName] = useState("");
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [emailDomains, setEmailDomains] = useState("");
  const [autoProvision, setAutoProvision] = useState(true);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    void (async () => {
      const me = await getCurrentUser();
      if (!me) {
        router.replace("/auth");
        return;
      }
      const t = await getTeams();
      setTeams(t);
      const adminTeam = t.find((team) => team.role === "ADMIN");
      if (adminTeam) setTeamId(adminTeam.id);
      setLoading(false);
    })();
  }, [router]);

  useEffect(() => {
    if (!teamId) {
      setConnection(null);
      return;
    }
    void (async () => {
      try {
        const conn = await getTeamSsoConnection(teamId);
        setConnection(conn);
        if (conn) {
          setDisplayName(conn.displayName);
          setIssuer(conn.issuer);
          setClientId(conn.clientId);
          setClientSecret("");
          setEmailDomains(conn.emailDomains.join(", "));
          setAutoProvision(conn.autoProvision);
          setEnabled(conn.enabled);
        } else {
          setDisplayName("");
          setIssuer("");
          setClientId("");
          setClientSecret("");
          setEmailDomains("");
          setAutoProvision(true);
          setEnabled(true);
        }
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [teamId]);

  const selectedTeam = teams.find((t) => t.id === teamId);
  const isAdmin = selectedTeam?.role === "ADMIN";
  const callbackUrl = teamId && selectedTeam
    ? `${API_BASE}/api/auth/sso/${selectedTeam.slug}/callback`
    : "";

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!teamId) return;
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      if (!clientSecret && connection) {
        throw new Error(
          "Client secret is required. Paste the value again — for security it is never returned after saving.",
        );
      }
      const domains = emailDomains
        .split(/[\s,]+/)
        .map((d) => d.trim())
        .filter(Boolean);
      const saved = await upsertTeamSsoConnection(teamId, {
        displayName,
        issuer,
        clientId,
        clientSecret,
        emailDomains: domains,
        autoProvision,
        enabled,
      });
      setConnection(saved);
      setClientSecret("");
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!teamId) return;
    if (!confirm("Remove the SSO connection for this team? Existing sessions stay valid.")) return;
    setError(null);
    try {
      await deleteTeamSsoConnection(teamId);
      setConnection(null);
      setDisplayName("");
      setIssuer("");
      setClientId("");
      setClientSecret("");
      setEmailDomains("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (loading) {
    return (
      <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: "var(--muted)" }}>Loading…</p>
      </main>
    );
  }

  return (
    <>
      <AppHeader />
      <main style={{ maxWidth: "720px", margin: "0 auto", padding: "var(--space-6) var(--space-4)" }}>
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Link href="/settings" style={{ color: "var(--muted)", fontSize: "var(--text-sm)", textDecoration: "none" }}>
            ← Settings
          </Link>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 700, marginTop: "var(--space-2)" }}>Enterprise SSO (OIDC)</h1>
          <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>
            Connect your company identity provider. Members whose email domain matches will be
            offered a one-click login and auto-provisioned into this team.
          </p>
        </div>

        <Card style={{ marginBottom: "var(--space-4)" }}>
          <FormField label="Team">
            <Select
              value={teamId}
              onChange={setTeamId}
              placeholder="Select a team…"
              options={teams.map((t) => ({
                value: t.id,
                label: t.role === "ADMIN" ? t.name : `${t.name} (requires admin)`,
              }))}
            />
          </FormField>
        </Card>

        {teamId && !isAdmin && (
          <AlertBanner tone="warning" title="Admin access required">
            Only team administrators can configure SSO.
          </AlertBanner>
        )}

        {teamId && isAdmin && (
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

              <FormField label={connection ? "Client secret (re-enter to update)" : "Client secret"}>
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                  required={!connection}
                  placeholder={connection ? "••••••••" : ""}
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
                  Your SSO connection was saved. Users matching the email domains will now see a
                  one-click login button.
                </AlertBanner>
              )}

              <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
                <Button type="submit" disabled={saving} loading={saving}>
                  {connection ? "Update connection" : "Create connection"}
                </Button>
                {connection && (
                  <Button type="button" variant="secondary" onClick={() => void handleDelete()}>
                    Remove
                  </Button>
                )}
              </div>
            </form>
          </Card>
        )}
      </main>
    </>
  );
}
