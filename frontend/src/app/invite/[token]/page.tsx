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
import Card from "../../../components/ui/Card";

type Phase =
  | { kind: "loading" }
  | { kind: "needs-login" }
  | { kind: "preview"; preview: InvitePreview }
  | { kind: "accepting" }
  | { kind: "accepted"; projectId: string; role: string; soloModeChanged: boolean }
  | { kind: "error"; code: "invalid_token" | "consumed" | "expired" | "already_member" | "unknown"; message: string };

/**
 * Invite landing page. Mounted at `/invite/[token]`.
 *
 * Flow:
 *   1. On mount: check session, then preview the invite. Either path can
 *      surface a 4xx that we map onto a phase.
 *   2. Logged-out user is parked on a "log in to accept" screen with a
 *      deep-link back here. Auth page redirects on success, so the second
 *      load resumes naturally; we don't carry the token across redirects
 *      in storage. The URL itself is the only carrier — that's why the
 *      backend persists tokens as sha256 hashes only.
 *   3. Accept either succeeds (route to project) or 409s
 *      (already-member); the latter is rendered inline rather than as a
 *      hard error so the user can navigate to the project they already
 *      have access to.
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
          setPhase({ kind: "preview", preview });
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
    setPhase({ kind: "accepting" });
    try {
      const result = await acceptInvite(token);
      setPhase({
        kind: "accepted",
        projectId: result.projectId,
        role: result.role,
        soloModeChanged: result.soloModeChanged,
      });
      // Soft auto-redirect after a short pause so the user sees the
      // confirmation. The accept response carries projectId, route the
      // user straight to the project they just gained access to.
      setTimeout(() => {
        router.push(`/projects/${result.projectId}/members`);
      }, 1500);
    } catch (err) {
      setPhase(toErrorPhase(err));
    }
  }

  return (
    <div style={{ maxWidth: 520, margin: "4rem auto", padding: "0 1rem" }}>
      <Card>
        <h1 style={{ marginTop: 0 }}>Project invitation</h1>
        {phase.kind === "loading" && <p>Loading invite...</p>}

        {phase.kind === "needs-login" && (
          <>
            <p>You need to be signed in to accept this invitation.</p>
            <Link href={`/auth?redirect=/invite/${token}`}>
              <Button>Sign in to continue</Button>
            </Link>
          </>
        )}

        {phase.kind === "preview" && (
          <PreviewBody preview={phase.preview} onAccept={handleAccept} />
        )}

        {phase.kind === "accepting" && <p>Accepting invitation...</p>}

        {phase.kind === "accepted" && (
          <>
            <AlertBanner tone="success">
              Welcome aboard. Role: <strong>{phase.role}</strong>.
            </AlertBanner>
            {phase.soloModeChanged && (
              <AlertBanner tone="info">
                This was the project&apos;s first invitation. Solo-mode has been
                disabled and the distinct-reviewer gate is now active for all
                future tasks.
              </AlertBanner>
            )}
            <p style={{ marginTop: "1rem" }}>
              Redirecting to the project, or{" "}
              <Link href={`/projects/${phase.projectId}/members`}>go now</Link>.
            </p>
          </>
        )}

        {phase.kind === "error" && (
          <ErrorBody code={phase.code} message={phase.message} />
        )}
      </Card>
    </div>
  );
}

function PreviewBody({
  preview,
  onAccept,
}: {
  preview: InvitePreview;
  onAccept: () => void;
}) {
  const expiresAtDate = new Date(preview.expiresAt);
  return (
    <>
      <p>
        <strong>{preview.ownerLogin}</strong> invited you to collaborate on{" "}
        <strong>{preview.projectName}</strong> (<code>{preview.projectSlug}</code>).
      </p>
      <ul>
        <li>
          Role: <strong>{preview.role}</strong>
        </li>
        <li>
          Expires: {expiresAtDate.toLocaleString()}
        </li>
      </ul>
      <p style={{ fontSize: "0.9em", color: "var(--color-text-muted, #666)" }}>
        Note: project membership grants access to tasks and PR operations on
        agent-tasks. To push code or open PRs in the linked GitHub
        repository you also need GitHub-side collaborator access; ask the
        project owner if you don&apos;t have it yet.
      </p>
      <Button onClick={onAccept}>Accept invitation</Button>
    </>
  );
}

function ErrorBody({
  code,
  message,
}: {
  code: "invalid_token" | "consumed" | "expired" | "already_member" | "unknown";
  message: string;
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
  return (
    <>
      <AlertBanner tone={tone}>{headline}</AlertBanner>
      {/* Suppress the raw message on `unknown` errors. A 5xx tends to
          carry stack-trace fragments that don't help the user and risk
          leaking internals. The known error codes have headlines
          tailored above. The original message is kept in the parent
          phase state for support diagnostics. */}
      <p style={{ marginTop: "1rem", fontSize: "0.85em", color: "#888" }}>
        Reference: <code>{code}</code>
      </p>
      <p>
        <Link href="/dashboard">Back to dashboard</Link>
      </p>
    </>
  );
}

type ErrorCode = "invalid_token" | "consumed" | "expired" | "already_member" | "unknown";

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
