/**
 * User-facing messages for /auth/error?reason=<code>.
 *
 * Producers: the GitHub OAuth callback (backend/src/routes/auth.ts) and the
 * SSO login callback (backend/src/routes/sso.ts) redirect here with a single
 * `reason` query parameter. Provider-supplied values (`error` on the OAuth /
 * OIDC callback) are forwarded after a [A-Za-z0-9_-] filter, so the set of
 * codes is open: an unknown code gets the generic fallback.
 *
 * Lives next to the page, not in it: Next forbids extra exports from a page
 * file.
 */

export const GENERIC_AUTH_ERROR_MESSAGE =
  "Something went wrong during authentication. Please try again.";

const DECLINED = "You declined the authorization request. Try again when you are ready.";
const PROVIDER_DOWN =
  "The sign-in provider is temporarily unavailable. Please try again in a few minutes.";
const PROVIDER_NEEDS_LOGIN =
  "The sign-in provider needs you to sign in or confirm access again. Please try again.";

const MESSAGES: ReadonlyMap<string, string> = new Map([
  // GitHub OAuth callback
  ["callback_failed", "Something went wrong during GitHub sign-in. Please try again."],
  [
    "session_mismatch",
    "Your session changed while connecting GitHub. Sign in again, then retry from Settings.",
  ],
  // Shared by the GitHub and SSO callbacks
  ["bad_request", "The sign-in response was incomplete. Please start the sign-in again."],
  [
    "state_mismatch",
    "The sign-in could not be verified, for example because the page was open for too long or cookies were blocked. Please start the sign-in again in the same browser.",
  ],
  // OAuth / OIDC error codes a provider sends back
  ["access_denied", DECLINED],
  ["server_error", PROVIDER_DOWN],
  ["temporarily_unavailable", PROVIDER_DOWN],
  ["login_required", PROVIDER_NEEDS_LOGIN],
  ["consent_required", PROVIDER_NEEDS_LOGIN],
  ["interaction_required", PROVIDER_NEEDS_LOGIN],
  // SSO login callback
  [
    "sso_unavailable",
    "Single sign-on is unavailable right now. Please try again later or contact your team admin.",
  ],
  [
    "sso_not_configured",
    "Single sign-on is not set up for this team. Please contact your team admin.",
  ],
  [
    "not_provisioned",
    "Your account is not set up for this team yet. Ask a team admin to add you, then try again.",
  ],
  [
    "sso_failed",
    "Single sign-on failed. Please try again; if it keeps failing, contact your team admin.",
  ],
]);

/** Reason codes with their own message (the generic fallback covers the rest). */
export const KNOWN_AUTH_ERROR_REASONS: readonly string[] = [...MESSAGES.keys()];

const SAFE_REASON = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * The reason to show as a support reference, or null when the value is
 * missing or not in the charset the backend forwards. Anything else (a
 * hand-edited URL) is never echoed.
 */
export function referenceFor(reason: string | null): string | null {
  return reason !== null && SAFE_REASON.test(reason) ? reason : null;
}

/** The message for a reason code; unknown, empty or malformed codes get the generic one. */
export function authErrorMessage(reason: string | null): string {
  const safe = referenceFor(reason);
  return (safe !== null ? MESSAGES.get(safe) : undefined) ?? GENERIC_AUTH_ERROR_MESSAGE;
}
