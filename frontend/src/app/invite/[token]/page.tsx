"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  acceptInvite,
  ApiRequestError,
  getCurrentUser,
  previewInvite,
  type InvitePreview,
} from "../../../lib/api";
import AlertBanner from "../../../components/ui/AlertBanner";
import { Button } from "../../../components/ui/Button";
import { SkeletonList } from "../../../components/ui/Skeleton";
import { roleLabel } from "../../../lib/roleLabel";
import { AuthShell } from "../../../components/AuthShell";

type ErrorCode = "invalid_token" | "consumed" | "expired" | "already_member" | "unknown";

type Phase =
  | { kind: "loading" }
  | { kind: "needs-login" }
  | { kind: "preview"; preview: InvitePreview; accepting: boolean }
  | { kind: "accepted"; projectId: string; role: string; soloModeChanged: boolean }
  | { kind: "error"; code: ErrorCode; message: string; ownerLogin?: string };

/**
 * Invite landing page. Mounted at /invite/[token].
 *
 * Flow:
 *   1. On mount: check session, then preview the invite. Either path can
 *      surface a 4xx that we map onto a phase.
 *   2. Logged-out user is parked on a "log in to accept" screen with a
 *      deep-link back here. Auth page redirects on success, so the second
 *      load resumes naturally; we don't carry the token across redirects
 *      in storage. The URL itself is the only carrier.
 *   3. Accept either succeeds (route to project) or 409s (already-member);
 *      the latter is rendered inline rather than as a hard error so the user
 *      can navigate to the project they already have access to.
 *   4. While accepting, the preview stays mounted with the button in loading
 *      state so there is no card collapse or content shift.
 */
export default function InviteLandingPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const token = params.token;
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await getCurrentUser();
        if (cancelled) return;
        if (!me) {
          setPhase({ kind: "needs-login" });
          return;
        }
        try {
          const preview = await previewInvite(token);
          if (cancelled) return;
          setPhase({ kind: "preview", preview, accepting: false });
        } catch (err) {
          if (cancelled) return;
          setPhase(toErrorPhase(err));
        }
      } catch (err) {
        if (cancelled) return;
        setPhase(toErrorPhase(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleAccept() {
    if (phase.kind !== "preview") return;
    const { preview } = phase;
    // Keep preview mounted with loading button.
    setPhase({ kind: "preview", preview, accepting: true });
    try {
      const result = await acceptInvite(token);
      setPhase({
        kind: "accepted",
        projectId: result.projectId,
        role: result.role,
        soloModeChanged: result.soloModeChanged,
      });
      // Soft auto-redirect after a short pause so the user sees the confirmation.
      setTimeout(() => {
        router.push(`/projects/${result.projectId}/members`);
      }, 1500);
    } catch (err) {
      // Pass the ownerLogin through to the error phase so the error body can
      // show an actionable "ask X for a fresh invite" line.
      setPhase({ ...toErrorPhase(err), ownerLogin: preview.ownerLogin });
    }
  }

  return (
    <AuthShell heading="Project invitation">
      <div className="auth-form-grid">
        {phase.kind === "loading" && (
          <SkeletonList rows={2} rowHeight="1.5rem" label="Loading invitation" />
        )}

        {phase.kind === "needs-login" && (
          <>
            <p>You need to be signed in to accept this invitation.</p>
            <Button
              onClick={() => router.push(`/auth?redirect=/invite/${token}`)}
              className="auth-btn-full"
            >
              Sign in to continue
            </Button>
          </>
        )}

        {phase.kind === "preview" && (
          <PreviewBody
            preview={phase.preview}
            accepting={phase.accepting}
            onAccept={() => void handleAccept()}
          />
        )}

        {phase.kind === "accepted" && (
          <div className="auth-form-grid">
            <AlertBanner tone="success">
              Welcome aboard. Role: <strong>{roleLabel(phase.role)}</strong>.
            </AlertBanner>
            {phase.soloModeChanged && (
              <AlertBanner tone="info">
                This was the project&apos;s first invitation. Solo-mode has been
                disabled and the distinct-reviewer gate is now active for all
                future tasks.
              </AlertBanner>
            )}
            <p className="auth-muted-line">
              Redirecting to the project, or{" "}
              <Link href={`/projects/${phase.projectId}/members`}>go now</Link>.
            </p>
          </div>
        )}

        {phase.kind === "error" && (
          <ErrorBody
            code={phase.code}
            ownerLogin={phase.ownerLogin}
          />
        )}
      </div>
    </AuthShell>
  );
}

function PreviewBody({
  preview,
  accepting,
  onAccept,
}: {
  preview: InvitePreview;
  accepting: boolean;
  onAccept: () => void;
}) {
  const expiresAtDate = new Date(preview.expiresAt);
  return (
    <div className="auth-form-grid">
      <p>
        <strong>{preview.ownerLogin}</strong> invited you to collaborate on{" "}
        <strong>{preview.projectName}</strong> (<code>{preview.projectSlug}</code>).
      </p>
      <ul>
        <li>
          Role: <strong>{roleLabel(preview.role)}</strong>
        </li>
        <li>Expires: {expiresAtDate.toLocaleString()}</li>
      </ul>
      <p className="auth-muted-line">
        Note: project membership grants access to tasks and PR operations on
        agent-tasks. To push code or open PRs in the linked GitHub repository
        you also need GitHub-side collaborator access; ask the project owner if
        you do not have it yet.
      </p>
      {/* Button stays mounted while accepting, loading prop shows spinner. */}
      <Button
        onClick={onAccept}
        loading={accepting}
        disabled={accepting}
        className="auth-btn-full"
      >
        Accept invitation
      </Button>
    </div>
  );
}

function ErrorBody({
  code,
  ownerLogin,
}: {
  code: ErrorCode;
  ownerLogin?: string;
}) {
  const tone: "info" | "danger" = code === "already_member" ? "info" : "danger";
  const headline = (() => {
    switch (code) {
      case "invalid_token":
        return "This invitation link is not valid.";
      case "consumed":
        return "This invitation has already been used.";
      case "expired":
        return "This invitation has expired.";
      case "already_member":
        return "You already have access to this project.";
      default:
        return "Something went wrong, please try again.";
    }
  })();

  // Actionable recovery line when the invite is dead and we know who sent it.
  const showRefreshHint =
    (code === "expired" || code === "consumed" || code === "invalid_token") &&
    ownerLogin;

  return (
    <div className="auth-form-grid">
      <AlertBanner tone={tone}>{headline}</AlertBanner>
      {showRefreshHint && (
        <p className="auth-muted-line">
          Ask <strong>{ownerLogin}</strong> for a fresh invite link.
        </p>
      )}
      {/* Suppress the raw message on unknown errors: a 5xx may carry
          stack-trace fragments that do not help the user and risk leaking
          internals. Known error codes have tailored headlines above. */}
      <p className="auth-muted-line">
        Reference: <code>{code}</code>
      </p>
      <Link href="/home">Back to home</Link>
    </div>
  );
}

function toErrorPhase(err: unknown): { kind: "error"; code: ErrorCode; message: string } {
  if (err instanceof ApiRequestError) {
    const code: ErrorCode =
      err.code === "invalid_token" ||
      err.code === "consumed" ||
      err.code === "expired" ||
      err.code === "already_member"
        ? err.code
        : "unknown";
    return { kind: "error", code, message: err.message };
  }
  return {
    kind: "error",
    code: "unknown",
    message: err instanceof Error ? err.message : String(err),
  };
}
