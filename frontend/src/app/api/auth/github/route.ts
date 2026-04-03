import { redirect } from "next/navigation";

/**
 * Server-side redirect to the backend GitHub OAuth endpoint.
 * Avoids NEXT_PUBLIC_API_URL being baked into client HTML
 * and prevents SSR/CSR hydration mismatches.
 */
export function GET() {
  const apiUrl = process.env.API_URL ?? "http://localhost:3001";
  redirect(`${apiUrl}/api/auth/github`);
}
