"use client";

// Team settings: /settings/team. API tokens (Connect an agent, create, rename,
// revoke) and the Enterprise SSO entry. Personal settings (account,
// appearance, GitHub, agent permissions) live at /settings.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getCurrentUser,
  getTeams,
  getAgentTokens,
  type Team,
  type AgentToken,
} from "../../../lib/api";
import { settingsHref, ssoSettingsHref } from "../../../lib/routes";
import { useCurrentTeam } from "../../../lib/teamSwitch";
import AlertBanner from "../../../components/ui/AlertBanner";
import { Button } from "../../../components/ui/Button";
import Card from "../../../components/ui/Card";
import { FullPageLoader } from "../../../components/ui/FullPageLoader";
import { PageHeader } from "../../../components/ui/PageHeader";
import ApiTokensSection from "../../../components/settings/ApiTokensSection";

// Section ids for the sticky side-nav anchors.
const SECTIONS = [
  { id: "api-tokens", label: "API Tokens" },
  { id: "sso", label: "Enterprise SSO" },
];

export default function TeamSettingsPage() {
  const router = useRouter();
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeSection, setActiveSection] = useState<string>("api-tokens");

  // The current team is derived from the URL, the same input the header
  // switcher uses (?teamId, then the remembered team, then the first team).
  // The page keeps no team state of its own: a switch, back/forward and a
  // pasted link all re-resolve it.
  const team = useCurrentTeam(teams);
  const teamId = team?.id ?? null;

  // Tokens of the team that was loaded last, tagged with that team so the
  // section only ever renders tokens of the current team.
  const [loadedTokens, setLoadedTokens] = useState<{
    teamId: string;
    tokens: AgentToken[];
  } | null>(null);
  const [tokenError, setTokenError] = useState<{
    teamId: string;
    message: string;
  } | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    void (async () => {
      const me = await getCurrentUser();
      if (!me) {
        router.replace("/auth");
        return;
      }

      setTeams(await getTeams());
      setLoading(false);
    })();
  }, [router]);

  // Load the current team's tokens. The effect is keyed on the resolved team,
  // so the last resolution always wins: leaving a team (a later switch, back,
  // forward, unmount) cancels its load and a late response is dropped. A
  // failed load is shown in the section, never left unhandled.
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    setLoadedTokens(null);
    setTokenError(null);
    getAgentTokens(teamId)
      .then((tokens) => {
        if (!cancelled) setLoadedTokens({ teamId, tokens });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setTokenError({
          teamId,
          message: err instanceof Error ? err.message : "Failed to load API tokens.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, retryToken]);

  const tokensForTeam =
    loadedTokens && loadedTokens.teamId === teamId ? loadedTokens.tokens : null;
  const errorForTeam =
    tokenError && tokenError.teamId === teamId ? tokenError.message : null;

  // The sections only exist once loading is done, so the browser's own
  // hash scroll (including a /settings#api-tokens redirect) finds nothing on
  // arrival: scroll to the hash target here.
  useEffect(() => {
    if (loading) return;
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView();
  }, [loading]);

  // Scroll spy: update active section based on the section currently in view.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
          }
        }
      },
      { rootMargin: "-40% 0px -55% 0px", threshold: 0 },
    );

    for (const { id } of SECTIONS) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [loading]);

  if (loading) {
    return <FullPageLoader label="Loading team settings…" />;
  }

  return (
    <main className="page-shell">
      <PageHeader
        breadcrumb={
          <a href={settingsHref()} className="settings-breadcrumb">
            Settings
          </a>
        }
        title="Team settings"
      />

      <div className="settings-layout">
        {/* Sticky side-nav: hidden under 1000px via CSS */}
        <aside className="settings-side-nav" aria-label="Team settings sections">
          <nav>
            <p className="settings-side-nav-group-label">Developer</p>
            <a
              href="#api-tokens"
              className={`settings-side-nav-link${activeSection === "api-tokens" ? " settings-side-nav-link--active" : ""}`}
            >
              API Tokens
            </a>
            <p className="settings-side-nav-group-label">Integrations</p>
            <a
              href="#sso"
              className={`settings-side-nav-link${activeSection === "sso" ? " settings-side-nav-link--active" : ""}`}
            >
              Enterprise SSO
            </a>
          </nav>
        </aside>

        <div className="settings-content">
          <div className="settings-section-group">
            <p className="settings-group-eyebrow">Developer</p>

            {!team ? (
              <ApiTokensSection
                teams={teams}
                selectedTeamId=""
                initialTokens={[]}
              />
            ) : tokensForTeam ? (
              <ApiTokensSection
                key={team.id}
                teams={teams}
                selectedTeamId={team.id}
                initialTokens={tokensForTeam}
              />
            ) : (
              <Card>
                <section id="api-tokens">
                  <h2 className="settings-section-heading">API Tokens</h2>
                  <p className="settings-section-desc">
                    API tokens for <strong>{team.name}</strong>
                  </p>
                  {errorForTeam ? (
                    <>
                      <AlertBanner tone="danger" title="Could not load API tokens">
                        {errorForTeam}
                      </AlertBanner>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setRetryToken((n) => n + 1)}
                      >
                        Retry
                      </Button>
                    </>
                  ) : (
                    <p className="settings-section-desc" role="status">
                      Loading tokens…
                    </p>
                  )}
                </section>
              </Card>
            )}
          </div>

          <div className="settings-section-group">
            <p className="settings-group-eyebrow">Integrations</p>

            <Card>
              <section id="sso">
                <h2 className="settings-section-heading">Enterprise SSO</h2>
                <p className="settings-section-desc">
                  Configure OpenID Connect so members of your team can sign in with their
                  company identity provider (Okta, Azure AD, Google Workspace, Auth0,
                  Keycloak, and others). Gated by an API token with the{" "}
                  <code>sso:admin</code> scope -- not by your normal session -- so stolen
                  browser sessions cannot touch SSO config. Generate a token under{" "}
                  <a href="#api-tokens" className="settings-inline-link">
                    API Tokens
                  </a>{" "}
                  and hand it out-of-band to whoever owns IdP setup.
                </p>
                <Button href={ssoSettingsHref()} variant="secondary">
                  Manage SSO connection
                </Button>
              </section>
            </Card>
          </div>
        </div>
      </div>
    </main>
  );
}
