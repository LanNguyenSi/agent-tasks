"use client";

// Personal settings: /settings. Account, appearance, GitHub connection and
// agent permissions are per user. Team-scoped settings (API tokens, the
// Enterprise SSO entry) live at /settings/team; old `#api-tokens` / `#sso`
// links to this page are forwarded there (the hash never reaches the server,
// so the redirect is a client effect).

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  getCurrentUser,
  updateDelegationSettings,
  getGithubTokenHealth,
  type User,
  type GithubTokenHealth,
} from "../../lib/api";
import { teamSettingsHref } from "../../lib/routes";
import { usePageTeams } from "../../lib/teamList";
import { useResolvedTeam } from "../../lib/teamSwitch";
import AlertBanner from "../../components/ui/AlertBanner";
import { Button } from "../../components/ui/Button";
import Card from "../../components/ui/Card";
import { PageHeader } from "../../components/ui/PageHeader";
import { PageShell } from "../../components/ui/PageShell";
import { SkeletonList } from "../../components/ui/Skeleton";
import ThemePreferenceField from "../../components/ThemePreferenceField";
import { formatRelativeTime } from "../../components/settings/formatRelativeTime";

// Section ids for the sticky side-nav anchors.
const SECTIONS = [
  { id: "account", label: "Account" },
  { id: "appearance", label: "Appearance" },
  { id: "github", label: "GitHub" },
  { id: "delegation", label: "Agent Permissions" },
  { id: "team", label: "Team settings" },
];

// Anchors that used to live on this page and now live on /settings/team.
const TEAM_SETTINGS_HASHES: Record<string, "api-tokens" | "sso"> = {
  "#api-tokens": "api-tokens",
  "#sso": "sso",
};

export default function SettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeSection, setActiveSection] = useState<string>("account");
  const [error, setError] = useState<string | null>(null);

  // The team the "Open team settings" link carries: the shell resolves it
  // exactly like the header (URL ?teamId, then the remembered team, then the
  // first team) from the one shell team list, so /settings/team opens that
  // team and writes nothing into its own URL. Resolved, never written here:
  // personal settings are not team-scoped (`useResolvedTeam`, not
  // `useCurrentTeam`). Bare while no team resolves (no teams, list failed).
  const { teams } = usePageTeams(user !== null);
  const navTeam = useResolvedTeam(teams, searchParams?.get("teamId") ?? null);

  const [delegation, setDelegation] = useState({
    allowAgentPrCreate: false,
    allowAgentPrMerge: false,
    allowAgentPrComment: false,
  });
  const [delegationSaving, setDelegationSaving] = useState(false);
  const [delegationSuccess, setDelegationSuccess] = useState(false);

  const [tokenHealth, setTokenHealth] = useState<GithubTokenHealth | null>(null);

  const githubConnectedNow = useMemo(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("github_connected") === "1";
  }, []);

  // Forward old `/settings#api-tokens` and `/settings#sso` links.
  useEffect(() => {
    const section = TEAM_SETTINGS_HASHES[window.location.hash];
    if (section) router.replace(teamSettingsHref(section));
  }, [router]);

  useEffect(() => {
    void (async () => {
      const me = await getCurrentUser();
      if (!me) {
        router.replace("/auth");
        return;
      }
      setUser(me);
      setDelegation({
        allowAgentPrCreate: me.allowAgentPrCreate,
        allowAgentPrMerge: me.allowAgentPrMerge,
        allowAgentPrComment: me.allowAgentPrComment,
      });

      if (me.githubConnected) {
        void getGithubTokenHealth()
          .then(setTokenHealth)
          .catch(() =>
            setTokenHealth({ state: "unknown", lastCheckedAt: null }),
          );
      }

      setLoading(false);
    })();
  }, [router]);

  // Scroll spy: update active section based on the section currently in view.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            // At the top of the page the first section is current, even when
            // a later section already sits inside the observed band (the
            // first callback fires for it on load).
            setActiveSection(
              window.scrollY <= 0 ? SECTIONS[0]!.id : entry.target.id,
            );
          }
        }
      },
      { rootMargin: "-40% 0px -55% 0px", threshold: 0 },
    );

    const ids = SECTIONS.map((s) => s.id);
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [loading]);

  async function handleDelegationSave() {
    setDelegationSaving(true);
    setDelegationSuccess(false);
    setError(null);
    try {
      const updated = await updateDelegationSettings(delegation);
      setUser(updated);
      setDelegationSuccess(true);
      setTimeout(() => setDelegationSuccess(false), 3000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDelegationSaving(false);
    }
  }

  if (loading) {
    // The real band and column while loading, so the title does not move
    // when the sections arrive.
    return (
      <PageShell busy header={<PageHeader title="Settings" />}>
        <SkeletonList rows={4} rowHeight="8rem" label="Loading settings…" />
      </PageShell>
    );
  }

  const isDelegationDirty = user
    ? delegation.allowAgentPrCreate !== user.allowAgentPrCreate ||
      delegation.allowAgentPrMerge !== user.allowAgentPrMerge ||
      delegation.allowAgentPrComment !== user.allowAgentPrComment
    : false;

  return (
    <PageShell header={<PageHeader title="Settings" />}>
      <div className="settings-layout">
        {/* Sticky side-nav: hidden under 1000px via CSS */}
        <aside className="settings-side-nav" aria-label="Settings sections">
          <nav>
            <p className="settings-side-nav-group-label">Account &amp; Appearance</p>
            <a
              href="#account"
              className={`settings-side-nav-link${activeSection === "account" ? " settings-side-nav-link--active" : ""}`}
              aria-current={activeSection === "account" ? "location" : undefined}
            >
              Account
            </a>
            <a
              href="#appearance"
              className={`settings-side-nav-link${activeSection === "appearance" ? " settings-side-nav-link--active" : ""}`}
              aria-current={activeSection === "appearance" ? "location" : undefined}
            >
              Appearance
            </a>
            <p className="settings-side-nav-group-label">Integrations</p>
            <a
              href="#github"
              className={`settings-side-nav-link${activeSection === "github" ? " settings-side-nav-link--active" : ""}`}
              aria-current={activeSection === "github" ? "location" : undefined}
            >
              GitHub
            </a>
            <a
              href="#delegation"
              className={`settings-side-nav-link${activeSection === "delegation" ? " settings-side-nav-link--active" : ""}`}
              aria-current={activeSection === "delegation" ? "location" : undefined}
            >
              Agent Permissions
            </a>
            <p className="settings-side-nav-group-label">Team</p>
            <a
              href="#team"
              className={`settings-side-nav-link${activeSection === "team" ? " settings-side-nav-link--active" : ""}`}
              aria-current={activeSection === "team" ? "location" : undefined}
            >
              Team settings
            </a>
          </nav>
        </aside>

        <div className="settings-content">
          {/* Group 1: Account & Appearance */}
          <div className="settings-section-group">
            <p className="settings-group-eyebrow">Account &amp; Appearance</p>

            <Card>
              <section id="account">
                <h2 className="settings-section-heading">Account</h2>
                <dl className="settings-account-list">
                  <dt>Login</dt>
                  <dd>{user?.login}</dd>
                  <dt>Name</dt>
                  <dd>{user?.name ?? "Not set"}</dd>
                  <dt>Email</dt>
                  <dd>{user?.email ?? "Not set"}</dd>
                </dl>
              </section>
            </Card>

            <Card>
              <section id="appearance">
                <h2 className="settings-section-heading">Appearance</h2>
                <p className="settings-section-desc">
                  Choose how agent-tasks looks on this device. The preference is stored
                  locally in your browser.
                </p>
                <ThemePreferenceField />
              </section>
            </Card>
          </div>

          {/* Group 2: Integrations */}
          <div className="settings-section-group">
            <p className="settings-group-eyebrow">Integrations</p>

            <Card>
              <section id="github">
                <h2 className="settings-section-heading">GitHub Integration</h2>
                {githubConnectedNow && (
                  <AlertBanner tone="success" title="Connection updated">
                    GitHub connected successfully.
                  </AlertBanner>
                )}
                {user?.githubConnected ? (
                  tokenHealth?.state === "invalid" ? (
                    <div>
                      <AlertBanner tone="danger" title="GitHub token invalid">
                        Your GitHub token has been revoked or expired. Repo sync, PR
                        create/merge/comment, and the <code>ciGreen</code> transition
                        gate are currently failing for your account. Reconnect to
                        restore them.
                      </AlertBanner>
                      <Button href="/api/auth/github/connect" variant="secondary">
                        Reconnect GitHub
                      </Button>
                    </div>
                  ) : tokenHealth?.state === "unknown" ? (
                    <div>
                      <AlertBanner tone="info">
                        GitHub is connected. Could not verify token health just now.
                        {tokenHealth.lastCheckedAt && (
                          <span className="settings-github-check-time">
                            Last checked {formatRelativeTime(tokenHealth.lastCheckedAt)}.
                          </span>
                        )}
                      </AlertBanner>
                    </div>
                  ) : (
                    <AlertBanner tone="success">
                      GitHub is connected. Sync is available.
                      {tokenHealth?.state === "healthy" && tokenHealth.lastCheckedAt && (
                        <span className="settings-github-check-time">
                          Token verified {formatRelativeTime(tokenHealth.lastCheckedAt)}.
                        </span>
                      )}
                    </AlertBanner>
                  )
                ) : (
                  <div>
                    <AlertBanner tone="warning" title="GitHub not connected">
                      No GitHub connection yet. Repository sync is disabled until you
                      connect GitHub.
                    </AlertBanner>
                    <Button href="/api/auth/github/connect" variant="secondary">
                      Connect GitHub
                    </Button>
                  </div>
                )}
              </section>
            </Card>

            <Card>
              <section id="delegation">
                <h2 className="settings-section-heading">Agent Permissions</h2>
                <p className="settings-section-desc">
                  Allow agents to perform GitHub actions on your behalf. Without explicit
                  consent, agent requests are rejected.
                </p>
                {!user?.githubConnected && (
                  <AlertBanner tone="warning">
                    Connect GitHub first to enable agent permissions.
                  </AlertBanner>
                )}
                <div
                  className="settings-delegation-grid"
                  /* dynamic: opacity/pointerEvents depend on runtime githubConnected state */
                  /* eslint-disable-next-line no-restricted-syntax */
                  style={{
                    opacity: user?.githubConnected ? 1 : 0.5, /* dynamic: auth state */
                    pointerEvents: user?.githubConnected ? "auto" : "none", /* dynamic: auth state */
                  }}
                >
                  {(
                    [
                      {
                        key: "allowAgentPrCreate" as const,
                        label: "Allow agents to create PRs on my behalf",
                      },
                      {
                        key: "allowAgentPrMerge" as const,
                        label: "Allow agents to merge PRs on my behalf",
                      },
                      {
                        key: "allowAgentPrComment" as const,
                        label: "Allow agents to comment on PRs on my behalf",
                      },
                    ] as const
                  ).map(({ key, label }) => (
                    <label key={key} className="settings-delegation-row">
                      <input
                        type="checkbox"
                        checked={delegation[key]}
                        disabled={!user?.githubConnected}
                        onChange={(e) =>
                          setDelegation((prev) => ({
                            ...prev,
                            [key]: e.target.checked,
                          }))
                        }
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
                <div className="settings-delegation-footer">
                  <Button
                    size="sm"
                    disabled={!user?.githubConnected || delegationSaving || !isDelegationDirty}
                    loading={delegationSaving}
                    onClick={() => void handleDelegationSave()}
                  >
                    Save
                  </Button>
                  {delegationSuccess ? (
                    <span className="settings-delegation-status settings-delegation-status--saved">
                      Saved
                    </span>
                  ) : isDelegationDirty ? (
                    <span className="settings-delegation-status">Unsaved changes</span>
                  ) : null}
                </div>
                {error && (
                  <AlertBanner tone="danger" title="Action failed">
                    {error}
                  </AlertBanner>
                )}
              </section>
            </Card>
          </div>

          {/* Group 3: Team */}
          <div className="settings-section-group">
            <p className="settings-group-eyebrow">Team</p>

            <Card>
              <section id="team">
                <h2 className="settings-section-heading">Team settings</h2>
                <p className="settings-section-desc">
                  API tokens and Enterprise SSO are managed per team.
                </p>
                <Button href={teamSettingsHref(undefined, navTeam?.id)} variant="secondary">
                  Open team settings
                </Button>
              </section>
            </Card>
          </div>
        </div>
      </div>
    </PageShell>
  );
}
