"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "../../../components/ui/Button";
import { FullPageLoader } from "../../../components/ui/FullPageLoader";
import { AuthShell } from "../../../components/AuthShell";

/**
 * Wraps the inner component in a Suspense boundary because useSearchParams()
 * requires it in Next.js 15 to avoid static prerender failures.
 */
export default function AuthErrorPage() {
  return (
    <Suspense fallback={<FullPageLoader label="Loading..." />}>
      <AuthErrorPageInner />
    </Suspense>
  );
}

// Map the ?error= query param the OAuth callback appends to a user-facing message.
// The backend currently passes values like "callback_failed", "access_denied", etc.
function errorMessage(code: string | null): string {
  switch (code) {
    case "access_denied":
      return "You declined the GitHub authorization request. Try again when you are ready.";
    case "callback_failed":
      return "Something went wrong during GitHub sign-in. Please try again.";
    case "no_email":
      return "Your GitHub account does not have a public email address. Add one in GitHub settings or use email/password sign-in.";
    case "email_taken":
      return "An account already exists for that email address. Sign in with email/password instead.";
    default:
      return "Something went wrong during authentication. Please try again.";
  }
}

function AuthErrorPageInner() {
  const searchParams = useSearchParams();
  const code = searchParams.get("error");

  return (
    <AuthShell heading="Authentication failed">
      <div className="auth-form-grid">
        <p className="auth-error-copy">{errorMessage(code)}</p>
        {code && (
          <p className="auth-muted-line">
            Reference: <code>{code}</code>
          </p>
        )}
        <Button href="/auth" className="auth-btn-full">
          Try again
        </Button>
      </div>
    </AuthShell>
  );
}
