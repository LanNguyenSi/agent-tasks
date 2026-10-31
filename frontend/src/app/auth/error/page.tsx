"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "../../../components/ui/Button";
import { FullPageLoader } from "../../../components/ui/FullPageLoader";
import { AuthShell } from "../../../components/AuthShell";
import { authErrorMessage, referenceFor } from "./messages";

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

function AuthErrorPageInner() {
  const searchParams = useSearchParams();
  // `reason` is the one parameter every producer uses (GitHub OAuth and SSO
  // callbacks in the backend); see ./messages.ts.
  const reason = searchParams.get("reason");
  const reference = referenceFor(reason);

  return (
    <AuthShell heading="Authentication failed">
      <div className="auth-form-grid">
        <p className="auth-error-copy">{authErrorMessage(reason)}</p>
        {reference && (
          <p className="auth-muted-line">
            Reference: <code>{reference}</code>
          </p>
        )}
        <Button href="/auth" className="auth-btn-full">
          Try again
        </Button>
      </div>
    </AuthShell>
  );
}
