"use client";

// Team settings: /settings/team. Team name (rename), API tokens (Connect an agent, create, rename,
// revoke) and the Enterprise SSO entry. Personal settings (account,
// appearance, GitHub, agent permissions) live at /settings.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getCurrentUser,
  getAgentTokens,
  type AgentToken,
} from "../../../lib/api";
import { settingsHref, ssoSettingsHref } from "../../../lib/routes";
import { useCurrentTeam } from "../../../lib/teamSwitch";
import { usePageTeams, useTeamList } from "../../../lib/teamList";
import AlertBanner from "../../../components/ui/AlertBanner";
import { Button } from "../../../components/ui/Button";
import Card from "../../../components/ui/Card";
import { PageHeader } from "../../../components/ui/PageHeader";
import { PageShell } from "../../../components/ui/PageShell";
import { SkeletonList } from "../../../components/ui/Skeleton";
import ApiTokensSection from "../../../components/settings/ApiTokensSection";
import TeamNameSection from "../../../components/settings/TeamNameSection";
import {
  TokenRevealBanner,
  useTokenReveals,
} from "../../../components/settings/TokenReveal";

// Section ids for the sticky side-nav anchors.
const SECTIONS = [
  { id: "team-name", label: "Team name" },
  { id: "api-tokens", label: "API Tokens" },
  { id: "sso", label: "Enterprise SSO" },
];

export default function TeamSettingsPage() {
  const router = useRouter();
  const [userReady, setUserReady] = useState(false);
  // The shell's team list (one lookup for the header and the pages), not a
  // copy of this page's own; empty until the session check answered, so
  // without a session no team resolves and nothing is requested or written
  // into the URL. `teamsHeld`: ?teamId names a team that list lacks and its
  // one refresh is pending.
  const { teams, status: teamsStatus, held: teamsHeld } = usePageTeams(userReady);
  // A rename reloads the shell's one list, so the header, the switcher and
  // this page all show the new name without a page reload.
  const { refreshTeams } = useTeamList();
  const [activeSection, setActiveSection] = useState<string>("team-name");

  // The current team is derived from the URL, the same input the header
  // switcher uses (?teamId, then the remembered team, then the first team).
  // The page keeps no team state of its own: a switch, back/forward and a
  // pasted link all re-resolve it.
  const team = useCurrentTeam(teams, { hold: teamsHeld });
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

  // One-time secrets of created tokens live here, not in the section: the
  // section remounts on a team switch, and a create that is still in flight
  // then answers after its section is gone. Each reveal is tagged with the
  // team it was created in.
  const reveals = useTokenReveals();
  // Creates that failed after their section was gone, naming their team.
  const [createFailures, setCreateFailures] = useState<
    { id: number; teamName: string; message: string }[]
  >([]);
  const failureSeq = useRef(0);
  const teamIdRef = useRef<string | null>(null);
  useEffect(() => {
    teamIdRef.current = teamId;
  }, [teamId]);
  const handleCreateFailed = useCallback(
    (_teamId: string, teamName: string, message: string) => {
      failureSeq.current += 1;
      const id = failureSeq.current;
      setCreateFailures((prev) => [...prev, { id, teamName, message }]);
    },
    [],
  );
  // Tokens created for the team now on screen while its section was gone (a
  // switch away and back). A list loaded before the create answered does not
  // have them: they are appended to it, so nothing is reloaded and an open
  // dialog in the section stays open. Cleared with the list, whenever a load
  // for the team starts.
  const [addedTokens, setAddedTokens] = useState<AgentToken[]>([]);
  const handleCreatedAway = useCallback((createdTeamId: string, token: AgentToken) => {
    if (createdTeamId === teamIdRef.current) setAddedTokens((prev) => [...prev, token]);
  }, []);

  useEffect(() => {
    void (async () => {
      const me = await getCurrentUser();
      if (!me) {
        router.replace("/auth");
        return;
      }

      setUserReady(true);
    })();
  }, [router]);

  // Loading until the user is known and the shell's team list has answered.
  // A failed list lookup keeps the page loading, as the page's own failed
  // lookup did.
  const loading = !userReady || teamsStatus !== "ready";

  // Load the current team's tokens. The effect is keyed on the resolved team,
  // so the last resolution always wins: leaving a team (a later switch, back,
  // forward, unmount) cancels its load and a late response is dropped. A
  // failed load is shown in the section, never left unhandled.
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    setLoadedTokens(null);
    setTokenError(null);
    setAddedTokens([]);
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

  const foreignReveals = reveals.reveals.filter((r) => r.teamId !== teamId);
  // The current team's reveals show in its section; while that section is not
  // there (list loading or failed) they show in its place, never nowhere.
  const currentReveals = reveals.reveals.filter((r) => r.teamId === teamId);

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

  // The same band in both states, so the title does not move when the
  // sections arrive.
  const header = (
    <PageHeader
      breadcrumb={
        <a href={settingsHref()} className="settings-breadcrumb">
          Settings
        </a>
      }
      title="Team settings"
    />
  );

  if (loading) {
    return (
      <PageShell busy header={header}>
        <SkeletonList rows={3} rowHeight="8rem" label="Loading team settings…" />
      </PageShell>
    );
  }

  return (
    <PageShell header={header}>
      <div className="settings-layout">
        {/* Sticky side-nav: hidden under 1000px via CSS */}
        <aside className="settings-side-nav" aria-label="Team settings sections">
          <nav>
            <p className="settings-side-nav-group-label">General</p>
            <a
              href="#team-name"
              className={`settings-side-nav-link${activeSection === "team-name" ? " settings-side-nav-link--active" : ""}`}
            >
              Team name
            </a>
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
          {team && (
            <div className="settings-section-group">
              <p className="settings-group-eyebrow">General</p>
              <TeamNameSection
                key={team.id}
                team={team}
                onRenamed={() => void refreshTeams()}
              />
            </div>
          )}

          <div className="settings-section-group">
            <p className="settings-group-eyebrow">Developer</p>

            {createFailures.map((f) => (
              <AlertBanner
                key={f.id}
                tone="danger"
                title={`Failed to create token for ${f.teamName}`}
                onDismiss={() =>
                  setCreateFailures((prev) => prev.filter((x) => x.id !== f.id))
                }
              >
                {f.message}
              </AlertBanner>
            ))}
            {foreignReveals.map((r) => (
              <TokenRevealBanner key={r.id} reveal={r} api={reveals} foreign />
            ))}

            {!team ? (
              <ApiTokensSection
                teams={teams}
                selectedTeamId=""
                initialTokens={[]}
                reveals={reveals}
                onCreateFailed={handleCreateFailed}
                onCreatedAway={handleCreatedAway}
              />
            ) : tokensForTeam ? (
              <ApiTokensSection
                key={team.id}
                teams={teams}
                selectedTeamId={team.id}
                initialTokens={tokensForTeam}
                reveals={reveals}
                onCreateFailed={handleCreateFailed}
                onCreatedAway={handleCreatedAway}
                addedTokens={addedTokens}
              />
            ) : (
              <Card>
                <section id="api-tokens">
                  <h2 className="settings-section-heading">API Tokens</h2>
                  <p className="settings-section-desc">
                    API tokens for <strong>{team.name}</strong>
                  </p>
                  {currentReveals.map((r) => (
                    <TokenRevealBanner key={r.id} reveal={r} api={reveals} />
                  ))}
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
    </PageShell>
  );
}
