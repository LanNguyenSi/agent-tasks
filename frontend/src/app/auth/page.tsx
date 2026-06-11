"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  discoverSso,
  getCurrentUser,
  getTeams,
  login,
  register,
  type SsoDiscoverResult,
} from "../../lib/api";
import AlertBanner from "../../components/ui/AlertBanner";
import { Button } from "../../components/ui/Button";
import FormField from "../../components/ui/FormField";
import { FullPageLoader } from "../../components/ui/FullPageLoader";
import { AuthShell } from "../../components/AuthShell";

type Mode = "login" | "register";

/**
 * Validate a ?redirect= parameter coming back from a deep link
 * (e.g. /invite/[token]). Allowlist same-origin paths under known
 * features so an attacker cannot craft an auth URL that bounces an
 * authenticated session to an external origin. The current allowlist
 * covers only invite landings; extend deliberately when new feature
 * deep-links need it.
 */
function safeRedirect(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//")) return null;
  if (raw.startsWith("/invite/")) return raw;
  return null;
}

/**
 * Wraps the inner client component in a Suspense boundary because
 * useSearchParams() opts the page into client-side rendering and
 * Next.js 15 refuses to statically prerender a route that hits the
 * search-params hook without a fallback. Without this the production
 * build fails with "useSearchParams() should be wrapped in a suspense
 * boundary at page /auth".
 */
export default function AuthPage() {
  return (
    <Suspense fallback={<FullPageLoader label="Loading..." />}>
      <AuthPageInner />
    </Suspense>
  );
}

// Inline GitHub mark (16px grid, currentColor fill).
function GitHubMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function AuthPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTarget = safeRedirect(searchParams.get("redirect"));
  const [checkingSession, setCheckingSession] = useState(true);
  const [mode, setMode] = useState<Mode>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ssoMatch, setSsoMatch] = useState<SsoDiscoverResult | null>(null);
  const [redirectingToGithub, setRedirectingToGithub] = useState(false);

  // Reset the GitHub redirect button when the user navigates back from the
  // OAuth page (bfcache restore fires pageshow with persisted=true).
  useEffect(() => {
    function onPageShow(e: PageTransitionEvent) {
      if (e.persisted) {
        setRedirectingToGithub(false);
      }
    }
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  // SSO domain discovery is triggered on blur (below) rather than on every
  // keystroke, to avoid sending partial emails to the backend. It only runs
  // in login mode: in register mode there is no existing SSO to match.
  async function checkSsoForEmail() {
    if (mode !== "login") {
      setSsoMatch(null);
      return;
    }
    if (!email.includes("@") || email.length < 5) {
      setSsoMatch(null);
      return;
    }
    try {
      const match = await discoverSso(email);
      setSsoMatch(match);
    } catch {
      setSsoMatch(null);
    }
  }

  useEffect(() => {
    void (async () => {
      const me = await getCurrentUser();
      if (me) {
        if (redirectTarget) {
          router.replace(redirectTarget);
          return;
        }
        const teams = await getTeams();
        router.replace(teams.length === 0 ? "/onboarding" : "/home");
        return;
      }
      setCheckingSession(false);
    })();
  }, [router, redirectTarget]);

  // Clear SSO match when switching to register mode.
  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    if (next === "register") setSsoMatch(null);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === "register") {
        await register({ email, password, name: name || undefined });
      } else {
        await login({ email, password });
      }
      if (redirectTarget) {
        router.replace(redirectTarget);
        return;
      }
      const teams = await getTeams();
      router.replace(teams.length === 0 ? "/onboarding" : "/home");
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  if (checkingSession) {
    return <FullPageLoader label="Loading..." />;
  }

  const ssoHref = ssoMatch
    ? `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"}${ssoMatch.loginUrl}`
    : undefined;

  // When SSO discovery matches, the SSO button becomes the primary CTA so the
  // password submit is demoted to secondary. Only one primary CTA at a time.
  const submitVariant = ssoMatch ? "secondary" : "primary";

  return (
    <AuthShell
      heading={mode === "register" ? "Create your account" : "Sign in"}
      subtitle={
        mode === "register"
          ? "Start with a free account."
          : "Welcome back."
      }
    >
      <div className="auth-form-grid">
        {/* GitHub: primary CTA, always on top. Real loading/disabled semantics
            via aria-disabled + keydown guard + pageshow reset on back-navigation. */}
        <a
          href="/api/auth/github"
          className="btn-primary btn--box btn--md auth-github-btn"
          aria-disabled={redirectingToGithub || undefined}
          onClick={(e) => {
            if (redirectingToGithub) {
              e.preventDefault();
              return;
            }
            setRedirectingToGithub(true);
          }}
          onKeyDown={(e) => {
            if (redirectingToGithub && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
            }
          }}
        >
          {redirectingToGithub ? (
            <span className="btn-spinner" aria-hidden="true" />
          ) : (
            <GitHubMark />
          )}
          <span>
            {redirectingToGithub ? "Redirecting to GitHub..." : "Continue with GitHub"}
          </span>
          {redirectingToGithub && <span className="sr-only">Loading</span>}
        </a>

        <div className="auth-divider" aria-hidden="true">
          or continue with email
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="auth-form-grid">
          {mode === "register" && (
            <FormField label="Name (optional)">
              <input
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Doe"
              />
            </FormField>
          )}

          <FormField label="Email">
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => void checkSsoForEmail()}
              placeholder="you@example.com"
              required
            />
          </FormField>

          <FormField
            label="Password"
            hint={mode === "register" ? "At least 8 characters" : undefined}
          >
            <input
              type="password"
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
            />
          </FormField>

          {mode === "login" && (
            <p className="auth-forgot-hint">
              Forgot your password? Contact your workspace admin to reset it.
            </p>
          )}

          {ssoMatch && ssoHref && (
            <AlertBanner tone="info" title={`${ssoMatch.teamName} uses single sign-on`}>
              <div className="auth-form-grid">
                <span>Your company has configured SSO for this email domain.</span>
                <Button href={ssoHref} className="auth-btn-full">
                  Continue with {ssoMatch.displayName}
                </Button>
              </div>
            </AlertBanner>
          )}

          {error && (
            <AlertBanner tone="danger" title="Error">
              {error}
            </AlertBanner>
          )}

          <Button
            type="submit"
            variant={submitVariant}
            disabled={submitting}
            loading={submitting}
            className="auth-btn-full"
          >
            {mode === "register" ? "Create account" : "Sign in"}
          </Button>
        </form>

        <p className="auth-mode-toggle">
          {mode === "login" ? "No account yet?" : "Already have an account?"}{" "}
          <button
            type="button"
            className="auth-mode-toggle-btn"
            onClick={() => switchMode(mode === "login" ? "register" : "login")}
          >
            {mode === "login" ? "Create one" : "Sign in"}
          </button>
        </p>
      </div>
    </AuthShell>
  );
}
