"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  acceptInvite,
  getCurrentUser,
  previewInvite,
  type InvitePreview,
  type User,
} from "../../../lib/api";
import AlertBanner from "../../../components/ui/AlertBanner";
import { Button } from "../../../components/ui/Button";
import Card from "../../../components/ui/Card";

type Phase =
  | { kind: "loading" }
  | { kind: "needs-login" }
  | { kind: "preview"; preview: InvitePreview }
  | { kind: "accepting" }
  | { kind: "accepted"; projectId: string; role: string }
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
  const [, setUser] = useState<User | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await getCurrentUser();
        if (cancelled) return;
        setUser(me);
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
          const message = err instanceof Error ? err.message : String(err);
          const code = inferErrorCode(message);
          setPhase({ kind: "error", code, message });
        }
      } catch (err) {
        if (cancelled) return;
        setPhase({
          kind: "error",
          code: "unknown",
          message: err instanceof Error ? err.message : String(err),
        });
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
      setPhase({ kind: "accepted", projectId: result.projectId, role: result.role });
      // Soft auto-redirect after a short pause so the user sees the
      // confirmation. Hard redirect is also reachable via the manual link.
      setTimeout(() => {
        router.push("/dashboard");
      }, 1500);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = inferErrorCode(message);
      setPhase({ kind: "error", code, message });
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
            <p style={{ marginTop: "1rem" }}>
              Redirecting to your dashboard, or{" "}
              <Link href="/dashboard">go now</Link>.
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
        return "Something went wrong.";
    }
  })();
  return (
    <>
      <AlertBanner tone={tone}>{headline}</AlertBanner>
      {code === "unknown" && <p style={{ fontSize: "0.85em", color: "#888" }}>{message}</p>}
      <p style={{ marginTop: "1rem" }}>
        <Link href="/dashboard">Back to dashboard</Link>
      </p>
    </>
  );
}

function inferErrorCode(message: string):
  | "invalid_token"
  | "consumed"
  | "expired"
  | "already_member"
  | "unknown" {
  const m = message.toLowerCase();
  if (m.includes("not found") || m.includes("invalid")) return "invalid_token";
  if (m.includes("already used")) return "consumed";
  if (m.includes("expired")) return "expired";
  if (m.includes("already have access") || m.includes("already_member")) return "already_member";
  return "unknown";
}
