"use client";

/**
 * Legacy redirect: /projects/workflow?projectId=<id>
 * → /projects/<id>/workflow (hub layout route, stage F2).
 *
 * Reads the projectId query parameter and issues a client-side
 * router.replace to the canonical hub URL. Missing or invalid IDs
 * show an EmptyState with a "Go to dashboard" action instead of
 * a broken page.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import EmptyState from "../../../components/ui/EmptyState";
import { Button } from "../../../components/ui/Button";
import { Skeleton } from "../../../components/ui/Skeleton";

export default function WorkflowRedirectPage() {
  const router = useRouter();
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const projectId = params.get("projectId");

    // Validate: must be a non-empty string (UUID format is not enforced here;
    // the backend will reject an invalid id with a 404 anyway).
    if (!projectId || projectId.trim() === "") {
      setInvalid(true);
      return;
    }

    router.replace(`/projects/${projectId}/workflow`);
  }, [router]);

  if (invalid) {
    return (
      <main className="wf-redirect-shell">
        <EmptyState
          icon="box"
          title="Missing project ID"
          description="This URL is missing the required projectId parameter. Navigate to a project to open its workflow editor."
          action={
            <Button href="/dashboard" variant="primary" size="sm">
              Go to dashboard
            </Button>
          }
        />
      </main>
    );
  }

  // Show a brief loading state while the redirect fires.
  return (
    <main className="wf-redirect-shell">
      <div role="status" aria-busy="true">
        <span className="sr-only">Redirecting to workflow editor…</span>
        <div className="wf-redirect-loading">
          <Skeleton width={200} height="1.25rem" radius="var(--radius-sm)" />
          <Skeleton height="3.5rem" radius="var(--radius-lg)" />
        </div>
      </div>
    </main>
  );
}
