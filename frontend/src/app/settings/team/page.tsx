"use client";

// Team settings: /settings/team. API tokens (Connect an agent, create, rename,
// revoke) and the Enterprise SSO entry. Personal settings (account,
// appearance, GitHub, agent permissions) live at /settings.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getCurrentUser,
  getTeams,
  getAgentTokens,
  type Team,
  type AgentToken,
} from "../../../lib/api";
import { rememberTeam, resolveCurrentTeam } from "../../../lib/currentTeam";
import { settingsHref, ssoSettingsHref } from "../../../lib/routes";
import { useTeamChange } from "../../../lib/teamSwitch";
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
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  const [tokens, setTokens] = useState<AgentToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeSection, setActiveSection] = useState<string>("api-tokens");

  useEffect(() => {
    void (async () => {
      const me = await getCurrentUser();
      if (!me) {
        router.replace("/auth");
        return;
      }

      const t = await getTeams();
      setTeams(t);

      // Single current-team rule: ?teamId -> remembered team -> first team.
      const urlTeamId = new URLSearchParams(window.location.search).get("teamId");
      const team = resolveCurrentTeam(t, { urlTeamId });
      if (team) {
        if (team.id === urlTeamId) rememberTeam(team.id);
        setSelectedTeamId(team.id);
        const tok = await getAgentTokens(team.id);
        setTokens(tok);
      }

      setLoading(false);
    })();
  }, [router]);

  // The header switcher owns team switching: on a switch, load the new
  // team's tokens, then swap team and tokens together (the section below is
  // keyed by the team, so open dialogs and a revealed token of the old team
  // are dropped). The newest switch wins if several overlap.
  const switchSeq = useRef(0);
  useTeamChange((teamId) => {
    if (teamId === selectedTeamId || !teams.some((t) => t.id === teamId)) return;
    const seq = ++switchSeq.current;
    void getAgentTokens(teamId).then((tok) => {
      if (seq !== switchSeq.current) return;
      setTokens(tok);
      setSelectedTeamId(teamId);
    });
  });

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

            <ApiTokensSection
              key={selectedTeamId}
              teams={teams}
              selectedTeamId={selectedTeamId}
              initialTokens={tokens}
            />
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
