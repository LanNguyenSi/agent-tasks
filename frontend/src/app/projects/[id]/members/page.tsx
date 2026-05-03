"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  createProjectInvite,
  getCurrentUser,
  getProject,
  listProjectInvites,
  revokeProjectInvite,
  type Project,
  type ProjectInvite,
  type ProjectMemberRole,
  type User,
} from "../../../../lib/api";
import AppHeader from "../../../../components/AppHeader";
import AlertBanner from "../../../../components/ui/AlertBanner";
import { Button } from "../../../../components/ui/Button";
import Card from "../../../../components/ui/Card";
import FormField from "../../../../components/ui/FormField";
import Select from "../../../../components/ui/Select";

/**
 * Project members + invites admin surface.
 *
 * Mounted at `/projects/[id]/members`. Calls the backend endpoints
 * shipped in the per-project sharing cluster. Linkable directly; no
 * sidebar item yet (deferred so the dashboard restructure stays out of
 * scope here).
 *
 * Design follows the existing settings/tokens patterns: page-shell
 * layout, AppHeader, CSS variables (no hardcoded color hex), Card +
 * FormField + Select primitives, div-rows with shared border styling
 * instead of a hand-rolled table. Auth-gated by the backend; this page
 * surfaces raw error messages rather than blocking client-side so the
 * failure mode is honest.
 */
export default function ProjectMembersPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;

  const [user, setUser] = useState<User | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [invites, setInvites] = useState<ProjectInvite[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Invite-create form state
  const [role, setRole] = useState<ProjectMemberRole>("PROJECT_CONTRIBUTOR");
  const [ttlDays, setTtlDays] = useState("7");
  const [creating, setCreating] = useState(false);

  // Last-created invite to show plainToken once
  const [freshInvite, setFreshInvite] = useState<{
    inviteId: string;
    plainToken: string;
    shareUrl: string;
  } | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  async function refresh() {
    try {
      const [me, proj, inv] = await Promise.all([
        getCurrentUser(),
        getProject(projectId),
        listProjectInvites(projectId),
      ]);
      setUser(me);
      setProject(proj);
      setInvites(inv);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleCreate() {
    setCreating(true);
    try {
      const result = await createProjectInvite(projectId, {
        role,
        expiresInDays: parseInt(ttlDays, 10),
      });
      const shareUrl = `${window.location.origin}/invite/${result.plainToken}`;
      setFreshInvite({
        inviteId: result.invite.id,
        plainToken: result.plainToken,
        shareUrl,
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(inviteId: string) {
    try {
      await revokeProjectInvite(projectId, inviteId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function copyShareUrl() {
    if (!freshInvite) return;
    setCopyState("idle");
    try {
      // navigator.clipboard requires a secure context (HTTPS / localhost).
      // The catch handles browsers/environments where it's undefined or
      // the promise rejects so the user gets explicit "copy failed" UX
      // instead of silently believing the link was copied.
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(freshInvite.shareUrl);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <main className="page-shell">
      <AppHeader user={user ? { login: user.login, avatarUrl: user.avatarUrl } : null} />

      <p style={{ fontSize: "var(--text-sm)", marginBottom: "var(--space-3)" }}>
        <Link href="/dashboard" style={{ color: "var(--muted)" }}>
          ← Back to dashboard
        </Link>
      </p>

      <h1 style={{ marginBottom: "var(--space-2)" }}>Project members</h1>
      {project && (
        <p style={{ color: "var(--muted)", marginBottom: "var(--space-5)" }}>
          {project.name} ({project.slug})
        </p>
      )}

      {error && (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <AlertBanner tone="danger">{error}</AlertBanner>
        </div>
      )}
      {loading && <p style={{ color: "var(--muted)" }}>Loading...</p>}

      {freshInvite && (
        <Card style={{ marginBottom: "var(--space-4)" }}>
          <h2 style={{ marginTop: 0 }}>Invite link generated</h2>
          <AlertBanner tone="warning">
            This link is shown only once. Copy it now; the token cannot be
            retrieved later.
          </AlertBanner>
          <pre
            style={{
              background: "var(--surface-secondary)",
              border: "1px solid var(--border)",
              padding: "var(--space-3)",
              borderRadius: "var(--radius-sm, 6px)",
              wordBreak: "break-all",
              whiteSpace: "pre-wrap",
              fontSize: "var(--text-sm)",
              marginTop: "var(--space-3)",
            }}
          >
            {freshInvite.shareUrl}
          </pre>
          <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
            <Button onClick={() => void copyShareUrl()}>Copy share link</Button>
            <Button
              variant="ghost"
              onClick={() => {
                setFreshInvite(null);
                setCopyState("idle");
              }}
            >
              Dismiss
            </Button>
          </div>
          {copyState === "copied" && (
            <p
              style={{
                marginTop: "var(--space-2)",
                color: "var(--success)",
                fontSize: "var(--text-sm)",
              }}
            >
              Copied to clipboard.
            </p>
          )}
          {copyState === "failed" && (
            <p
              style={{
                marginTop: "var(--space-2)",
                color: "var(--danger)",
                fontSize: "var(--text-sm)",
              }}
            >
              Copy failed. Select the link above manually (Ctrl+A, Ctrl+C).
            </p>
          )}
        </Card>
      )}

      <Card style={{ marginBottom: "var(--space-4)" }}>
        <h2 style={{ marginTop: 0 }}>Create invite</h2>
        <p style={{ fontSize: "var(--text-sm)", color: "var(--muted)", marginBottom: "var(--space-3)" }}>
          Generates a one-time link. The recipient signs in and accepts to
          gain per-project access.
        </p>
        {project?.governanceMode === "AUTONOMOUS" && (
          <div style={{ marginBottom: "var(--space-3)" }}>
            <AlertBanner tone="warning">
              This project is currently autonomous (no distinct-reviewer
              gate). Accepting the first invite switches the project to
              dual-control automatically: agents will be required to find a
              different reviewer before merging.
            </AlertBanner>
          </div>
        )}
        <div style={{ display: "grid", gap: "var(--space-3)", gridTemplateColumns: "1fr 1fr", maxWidth: "480px" }}>
          <FormField label="Role">
            <Select
              value={role}
              onChange={(v) => setRole(v as ProjectMemberRole)}
              options={[
                { value: "PROJECT_VIEWER", label: "Viewer" },
                { value: "PROJECT_CONTRIBUTOR", label: "Contributor" },
                { value: "PROJECT_ADMIN", label: "Admin (team-ADMIN only)" },
              ]}
            />
          </FormField>
          <FormField label="Expires in">
            <Select
              value={ttlDays}
              onChange={(v) => setTtlDays(v)}
              options={[
                { value: "7", label: "7 days" },
                { value: "14", label: "14 days" },
                { value: "30", label: "30 days" },
              ]}
            />
          </FormField>
        </div>
        <div style={{ marginTop: "var(--space-3)" }}>
          <Button onClick={() => void handleCreate()} disabled={creating}>
            {creating ? "Creating..." : "Generate invite"}
          </Button>
        </div>
      </Card>

      <Card>
        <h2 style={{ marginTop: 0 }}>Invites</h2>
        {!invites || invites.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "var(--space-8) var(--space-4)",
              border: "1px dashed var(--border)",
              borderRadius: "10px",
              color: "var(--muted)",
            }}
          >
            No invites yet.
          </div>
        ) : (
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: "10px",
              overflow: "hidden",
            }}
          >
            {invites.map((inv, i) => (
              <div
                key={inv.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "var(--space-3)",
                  padding: "var(--space-3) var(--space-4)",
                  borderBottom: i < invites.length - 1 ? "1px solid var(--border)" : "none",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <p
                    style={{
                      fontWeight: 600,
                      fontSize: "var(--text-sm)",
                      marginBottom: "var(--space-1)",
                    }}
                  >
                    {inv.role}
                  </p>
                  <p
                    style={{
                      color: "var(--muted)",
                      fontSize: "var(--text-xs)",
                      margin: 0,
                    }}
                  >
                    <InviteStatusBadge status={inv.status} /> Expires{" "}
                    {new Date(inv.expiresAt).toLocaleString()}
                  </p>
                </div>
                {inv.status === "pending" && (
                  <Button
                    variant="outline-danger"
                    size="sm"
                    onClick={() => void handleRevoke(inv.id)}
                  >
                    Revoke
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </main>
  );
}

function InviteStatusBadge({ status }: { status: "pending" | "expired" | "consumed" }) {
  const tone = (() => {
    switch (status) {
      case "pending":
        return "var(--success)";
      case "expired":
        return "var(--warning)";
      case "consumed":
        return "var(--muted)";
    }
  })();
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0 var(--space-2)",
        marginRight: "var(--space-2)",
        borderRadius: "4px",
        background: "color-mix(in srgb, " + tone + " 15%, transparent)",
        color: tone,
        fontSize: "var(--text-xs)",
        fontWeight: 600,
        textTransform: "uppercase",
      }}
    >
      {status}
    </span>
  );
}
