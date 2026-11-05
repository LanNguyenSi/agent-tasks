import { redirect } from "next/navigation";
import { safeRedirect } from "../../../../lib/routes";

/**
 * Server-side redirect to the backend GitHub OAuth endpoint.
 * Avoids NEXT_PUBLIC_API_URL being baked into client HTML
 * and prevents SSR/CSR hydration mismatches.
 *
 * A deep-link target (`?redirect=`) is forwarded only when it passes the same
 * allowlist as the /auth page; the backend validates it again and carries it
 * across the GitHub round-trip in a short-lived cookie.
 */
export function GET(request: Request) {
  const apiUrl = process.env.API_URL ?? "http://localhost:3001";
  const target = safeRedirect(new URL(request.url).searchParams.get("redirect"));
  const query = target ? `?redirect=${encodeURIComponent(target)}` : "";
  redirect(`${apiUrl}/api/auth/github${query}`);
}
