"use client";

// Members & invites page: /projects/[id]/members.
// Shows current project members (via GET /projects/:id/members) above
// the invite-management controls.
// The hub layout renders the project name H1; this page renders content only.

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  createProjectInvite,
  getCurrentUser,
  getProject,
  listProjectInvites,
  listProjectMembers,
  revokeProjectInvite,
  type Project,
  type ProjectInvite,
  type ProjectMember,
  type ProjectMemberRole,
  type User,
} from "../../../../lib/api";
import AlertBanner from "../../../../components/ui/AlertBanner";
import { Button } from "../../../../components/ui/Button";
import Card from "../../../../components/ui/Card";
import ConfirmDialog from "../../../../components/ui/ConfirmDialog";
import EmptyState from "../../../../components/ui/EmptyState";
import FormField from "../../../../components/ui/FormField";
import Select from "../../../../components/ui/Select";
import { Skeleton, SkeletonList } from "../../../../components/ui/Skeleton";
import { roleLabel } from "../../../../lib/roleLabel";

export default function ProjectMembersPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;

  const [, setUser] = useState<User | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [members, setMembers] = useState<ProjectMember[] | null>(null);
  const [invites, setInvites] = useState<ProjectInvite[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [role, setRole] = useState<ProjectMemberRole>("PROJECT_CONTRIBUTOR");
  const [ttlDays, setTtlDays] = useState("7");
  const [creating, setCreating] = useState(false);

  const [freshInvite, setFreshInvite] = useState<{ shareUrl: string } | null>(
    null,
  );
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [revokeTarget, setRevokeTarget] = useState<{ id: string } | null>(
    null,
  );
  const [revoking, setRevoking] = useState(false);

  async function refresh() {
    try {
      const [me, proj, memberList, inv] = await Promise.all([
        getCurrentUser(),
        getProject(projectId),
        listProjectMembers(projectId).catch(() => [] as ProjectMember[]),
        listProjectInvites(projectId).catch(() => [] as ProjectInvite[]),
      ]);
      setUser(me);
      setProject(proj);
      setMembers(memberList);
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
      setFreshInvite({ shareUrl });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(inviteId: string) {
    setRevoking(true);
    try {
      await revokeProjectInvite(projectId, inviteId);
      await refresh();
      setRevokeTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRevoking(false);
    }
  }

  async function copyShareUrl() {
    if (!freshInvite) return;
    setCopyState("idle");
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(freshInvite.shareUrl);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  if (loading) {
    return (
      <div role="status" aria-busy="true">
        <span className="sr-only">Loading members and invites</span>
        {/* Members skeleton */}
        <Card surface="raised" className="mem-card">
          <Skeleton width={120} height="1rem" className="mem-skeleton-head" />
          <SkeletonList rows={3} rowHeight="3rem" label="Loading members" />
        </Card>
        {/* Invites skeleton */}
        <Card surface="raised">
          <Skeleton width={100} height="1rem" className="mem-skeleton-head" />
          <SkeletonList rows={2} rowHeight="3rem" label="Loading invites" />
        </Card>
      </div>
    );
  }

  return (
    <>
      {error && (
        <div className="mem-error">
          <AlertBanner tone="danger">{error}</AlertBanner>
        </div>
      )}

      {freshInvite && (
        <Card surface="raised" className="mem-card">
          <h2 className="mem-section-heading mem-section-heading--no-mb">
            Invite link generated
          </h2>
          <AlertBanner tone="warning">
            This link is shown only once. Copy it now; the token cannot be
            retrieved later.
          </AlertBanner>
          <pre className="mem-invite-pre">{freshInvite.shareUrl}</pre>
          <div className="mem-invite-actions">
            <Button onClick={() => void copyShareUrl()}>
              Copy share link
            </Button>
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
            <p className="mem-copy-status mem-copy-status--success">
              Copied to clipboard.
            </p>
          )}
          {copyState === "failed" && (
            <p className="mem-copy-status mem-copy-status--danger">
              Copy failed. Select the link above manually (Ctrl+A, Ctrl+C).
            </p>
          )}
        </Card>
      )}

      {/* ── Members ──────────────────────────────────────────────── */}
      <Card surface="raised" className="mem-card">
        <h2 className="mem-section-heading">Members</h2>
        {!members || members.length === 0 ? (
          <EmptyState
            icon="box"
            title="No direct members yet"
            description="Share an invite link below to grant per-project access."
            dashed
          />
        ) : (
          <div className="member-list">
            {members.map((m) => (
              <MemberRow key={m.id} member={m} />
            ))}
          </div>
        )}
      </Card>

      {/* ── Create invite ─────────────────────────────────────────── */}
      <Card surface="raised" className="mem-card">
        <h2 className="mem-section-heading mem-section-heading--no-mb">
          Create invite
        </h2>
        <p className="mem-desc">
          Generates a one-time link. The recipient signs in and accepts to gain
          per-project access.
        </p>
        {(project?.governanceMode === "AUTONOMOUS" ||
          (project?.governanceMode == null &&
            project?.soloMode === true)) && (
          <div className="mem-warning-wrap">
            <AlertBanner tone="warning">
              This project is currently autonomous (no distinct-reviewer gate).
              Accepting the first invite switches the project to dual-control
              automatically: agents will be required to find a different
              reviewer before merging.
            </AlertBanner>
          </div>
        )}
        <div className="mem-create-form-grid">
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
        <div className="mem-create-btn-row">
          <Button onClick={() => void handleCreate()} loading={creating}>
            Generate invite
          </Button>
        </div>
      </Card>

      {/* ── Invites list ──────────────────────────────────────────── */}
      <Card surface="raised">
        <h2 className="mem-section-heading">Invites</h2>
        {!invites || invites.length === 0 ? (
          <EmptyState
            icon="plus"
            title="No invites yet"
            description="Use Generate invite above to create a shareable link."
            dashed
          />
        ) : (
          <div className="mem-invite-list">
            {invites.map((inv) => (
              <div key={inv.id} className="mem-invite-row">
                <div className="mem-invite-row-text">
                  <p className="mem-invite-role">{roleLabel(inv.role)}</p>
                  <p className="mem-invite-meta">
                    <InviteStatusBadge status={inv.status} /> Expires{" "}
                    {new Date(inv.expiresAt).toLocaleString()}
                  </p>
                </div>
                {inv.status === "pending" && (
                  <Button
                    variant="outline-danger"
                    size="sm"
                    onClick={() => setRevokeTarget({ id: inv.id })}
                  >
                    Revoke
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={Boolean(revokeTarget)}
        title="Revoke invite?"
        message="This invite link will stop working immediately."
        confirmLabel="Revoke"
        cancelLabel="Keep"
        tone="danger"
        busy={revoking}
        onConfirm={() => {
          if (revokeTarget) void handleRevoke(revokeTarget.id);
        }}
        onCancel={() => {
          if (!revoking) setRevokeTarget(null);
        }}
      />
    </>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function MemberRow({ member }: { member: ProjectMember }) {
  const initials = (member.user.name ?? member.user.login)
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="member-row">
      {member.user.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- avatar URL is external (GitHub CDN), not a static asset for next/image
        <img
          src={member.user.avatarUrl}
          alt={member.user.login}
          className="member-avatar"
        />
      ) : (
        <span className="member-avatar-initials" aria-hidden="true">
          {initials}
        </span>
      )}
      <div className="member-info">
        <p className="member-login">{member.user.login}</p>
        <div className="member-meta">
          <span className="member-role-badge">{roleLabel(member.role)}</span>
          <span>
            Joined{" "}
            {new Date(member.joinedAt).toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
          </span>
        </div>
      </div>
    </div>
  );
}

function InviteStatusBadge({ status }: { status: ProjectInvite["status"] }) {
  return (
    <span className="mem-invite-badge" data-status={status}>
      {status}
    </span>
  );
}
