"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  createProjectInvite,
  getProject,
  listProjectInvites,
  revokeProjectInvite,
  type Project,
  type ProjectInvite,
  type ProjectMemberRole,
} from "../../../../lib/api";
import AlertBanner from "../../../../components/ui/AlertBanner";
import { Button } from "../../../../components/ui/Button";
import Card from "../../../../components/ui/Card";

/**
 * Project members + invites admin surface.
 *
 * Mounted at `/projects/[id]/members`. Calls the backend endpoints
 * shipped in PR #213 (Task 4 of the share-projects cluster). Linkable
 * directly; no sidebar item yet (deferred to a follow-up so the
 * dashboard restructure stays out of scope here).
 *
 * Auth assumption: the standard session cookie carries the user, the
 * backend enforces project-admin authority. A non-admin browsing
 * directly to this URL gets 403s on the API calls; we surface the
 * raw error message rather than blocking with a client-side gate so
 * the failure mode is honest.
 */
export default function ProjectMembersPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;

  const [project, setProject] = useState<Project | null>(null);
  const [invites, setInvites] = useState<ProjectInvite[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Invite-create form state
  const [role, setRole] = useState<ProjectMemberRole>("PROJECT_CONTRIBUTOR");
  const [ttlDays, setTtlDays] = useState(7);
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
      const [proj, inv] = await Promise.all([
        getProject(projectId),
        listProjectInvites(projectId),
      ]);
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
      const result = await createProjectInvite(projectId, { role, expiresInDays: ttlDays });
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
    <div style={{ maxWidth: 800, margin: "2rem auto", padding: "0 1rem" }}>
      <p style={{ fontSize: "0.85em" }}>
        <Link href="/dashboard">← Back to dashboard</Link>
      </p>
      <h1>Project members</h1>
      {project && <p style={{ color: "#666" }}>{project.name} ({project.slug})</p>}

      {error && <AlertBanner tone="danger">{error}</AlertBanner>}
      {loading && <p>Loading...</p>}

      {freshInvite && (
        <Card>
          <h2>Invite link generated</h2>
          <AlertBanner tone="warning">
            This link is shown only once. Copy it now; you cannot retrieve the token again.
          </AlertBanner>
          <pre
            style={{
              background: "#f4f4f4",
              padding: "0.75rem",
              borderRadius: "4px",
              wordBreak: "break-all",
              whiteSpace: "pre-wrap",
            }}
          >
            {freshInvite.shareUrl}
          </pre>
          <Button onClick={() => void copyShareUrl()}>Copy share link</Button>{" "}
          <Button onClick={() => { setFreshInvite(null); setCopyState("idle"); }}>Dismiss</Button>
          {copyState === "copied" && (
            <p style={{ marginTop: "0.5rem", color: "#0a0", fontSize: "0.85em" }}>
              Copied to clipboard.
            </p>
          )}
          {copyState === "failed" && (
            <p style={{ marginTop: "0.5rem", color: "#a00", fontSize: "0.85em" }}>
              Copy failed. Select the link above manually (Ctrl+A in the box, Ctrl+C).
            </p>
          )}
        </Card>
      )}

      <Card>
        <h2>Create invite</h2>
        <p style={{ fontSize: "0.85em", color: "#666" }}>
          Generates a one-time link. The recipient signs in and accepts to gain
          per-project access.
        </p>
        {project?.soloMode && (
          <AlertBanner tone="warning">
            This project is currently in solo-mode (no distinct-reviewer
            gate). Accepting the first invite will switch the project to
            dual-control automatically — agents will be required to find a
            different reviewer before merging.
          </AlertBanner>
        )}
        <div style={{ display: "flex", gap: "1rem", alignItems: "flex-end", flexWrap: "wrap" }}>
          <label>
            Role
            <br />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as ProjectMemberRole)}
            >
              <option value="PROJECT_VIEWER">Viewer</option>
              <option value="PROJECT_CONTRIBUTOR">Contributor</option>
              <option value="PROJECT_ADMIN">Admin (team-ADMIN only)</option>
            </select>
          </label>
          <label>
            Expires in
            <br />
            <select
              value={ttlDays}
              onChange={(e) => setTtlDays(parseInt(e.target.value, 10))}
            >
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
            </select>
          </label>
          <Button onClick={handleCreate} disabled={creating}>
            {creating ? "Creating..." : "Generate invite"}
          </Button>
        </div>
      </Card>

      <Card>
        <h2>Invites</h2>
        {!invites || invites.length === 0 ? (
          <p style={{ color: "#666" }}>No invites yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={cellStyle}>Role</th>
                <th style={cellStyle}>Status</th>
                <th style={cellStyle}>Expires</th>
                <th style={cellStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {invites.map((inv) => (
                <tr key={inv.id}>
                  <td style={cellStyle}>{inv.role}</td>
                  <td style={cellStyle}>{inv.status}</td>
                  <td style={cellStyle}>
                    {new Date(inv.expiresAt).toLocaleString()}
                  </td>
                  <td style={cellStyle}>
                    {inv.status === "pending" && (
                      <Button onClick={() => handleRevoke(inv.id)}>Revoke</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

const cellStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem",
  borderBottom: "1px solid #eee",
};
