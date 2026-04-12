"use client";

/**
 * Workflow & Gates — read-only viewer (Task 2/5 of the workflow editor).
 *
 * Shows the effective workflow (custom Workflow row or hardcoded system
 * default) for a single project. Admins additionally see a "Customize"
 * button that forks the default into a new Workflow row, enabling
 * editing in follow-up tasks. Editing itself is out of scope here.
 *
 * Route is query-param based (`/projects/workflow?projectId=…`) to match
 * the rest of the frontend which does not use Next.js dynamic segments.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  customizeProjectWorkflow,
  getCurrentUser,
  getEffectiveWorkflow,
  getProject,
  getTeams,
  getWorkflowRules,
  type EffectiveWorkflow,
  type Project,
  type Team,
  type User,
  type WorkflowRule,
} from "../../../lib/api";
import AppHeader from "../../../components/AppHeader";
import AlertBanner from "../../../components/ui/AlertBanner";
import { Button } from "../../../components/ui/Button";
import Card from "../../../components/ui/Card";

export default function WorkflowViewerPage() {
  const router = useRouter();
  // `undefined` = URL not read yet; `""` = read but missing.
  // Using three states avoids a hang when the effect can't distinguish
  // "still waiting for window.location" from "user opened the URL without
  // a projectId query param".
  const [projectId, setProjectId] = useState<string | undefined>(undefined);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setProjectId(params.get("projectId") ?? "");
  }, []);

  const [user, setUser] = useState<User | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [team, setTeam] = useState<Team | null>(null);
  const [workflow, setWorkflow] = useState<EffectiveWorkflow | null>(null);
  const [rules, setRules] = useState<WorkflowRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [customizing, setCustomizing] = useState(false);

  useEffect(() => {
    if (projectId === undefined) return; // URL not read yet
    if (projectId === "") {
      setError("Missing projectId query parameter. Link to this page with ?projectId=<uuid>.");
      setLoading(false);
      return;
    }
    const id = projectId; // narrow for closure

    void (async () => {
      try {
        const [me, proj, teams, wf, catalog] = await Promise.all([
          getCurrentUser(),
          getProject(id),
          getTeams(),
          getEffectiveWorkflow(id),
          getWorkflowRules(),
        ]);
        if (!me) {
          router.replace("/auth");
          return;
        }
        setUser(me);
        setProject(proj);
        setTeam(teams.find((t) => t.id === proj.teamId) ?? null);
        setWorkflow(wf);
        setRules(catalog);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [projectId, router]);

  const isAdmin = team?.role === "ADMIN";

  const ruleLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rules) map.set(r.id, r.label);
    return map;
  }, [rules]);

  async function handleCustomize() {
    if (!projectId) return;
    setCustomizing(true);
    setError(null);
    try {
      const next = await customizeProjectWorkflow(projectId);
      setWorkflow(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCustomizing(false);
    }
  }

  if (loading) {
    return (
      <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: "var(--muted)" }}>Loading workflow…</p>
      </main>
    );
  }

  if (error && !workflow) {
    return (
      <>
        <AppHeader user={user ? { login: user.login, avatarUrl: user.avatarUrl } : null} />
        <main style={{ maxWidth: "720px", margin: "0 auto", padding: "var(--space-6) var(--space-4)" }}>
          <AlertBanner tone="danger" title="Could not load workflow">
            {error}
          </AlertBanner>
        </main>
      </>
    );
  }

  if (!workflow || !project) return null;

  const def = workflow.definition;
  const isDefault = workflow.source === "default";

  return (
    <>
      <AppHeader user={user ? { login: user.login, avatarUrl: user.avatarUrl } : null} />
      <main style={{ maxWidth: "900px", margin: "0 auto", padding: "var(--space-6) var(--space-4)" }}>
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Link
            href={`/home?projectId=${project.id}`}
            style={{ color: "var(--muted)", fontSize: "var(--text-sm)", textDecoration: "none" }}
          >
            ← {project.name}
          </Link>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 700, marginTop: "var(--space-2)" }}>
            Workflow &amp; Gates
          </h1>
          <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>
            Defines which task state transitions are allowed for this project and which
            preconditions (gates) must be satisfied before each one. See{" "}
            <a
              href="https://github.com/LanNguyenSi/agent-tasks/blob/master/docs/workflow-preconditions.md"
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--primary, #3b82f6)" }}
            >
              workflow-preconditions.md
            </a>{" "}
            for background.
          </p>
        </div>

        <AlertBanner tone={isDefault ? "info" : "success"} title={isDefault ? "Using system default" : "Custom workflow"}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
            <span>
              {isDefault
                ? "This project inherits the built-in default workflow. It applies to every project that hasn't defined its own."
                : "This project has its own workflow row. Editing (coming in follow-up tasks) will go here."}
            </span>
            {isDefault && isAdmin && (
              <Button
                type="button"
                onClick={() => void handleCustomize()}
                disabled={customizing}
                loading={customizing}
              >
                Customize this workflow
              </Button>
            )}
            {isDefault && !isAdmin && (
              <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>
                Only team admins can customize.
              </span>
            )}
          </div>
        </AlertBanner>

        {error && (
          <AlertBanner tone="danger" title="Error">
            {error}
          </AlertBanner>
        )}

        <Card style={{ marginTop: "var(--space-4)" }}>
          <h2 style={{ fontSize: "var(--text-base)", fontWeight: 700, marginBottom: "var(--space-2)" }}>States</h2>
          <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", marginBottom: "var(--space-3)" }}>
            Initial state: <code>{def.initialState}</code>
          </p>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--text-sm)" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={th}>Name</th>
                  <th style={th}>Label</th>
                  <th style={th}>Terminal</th>
                  <th style={th}>Agent instructions</th>
                </tr>
              </thead>
              <tbody>
                {def.states.map((s) => (
                  <tr key={s.name} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={td}><code>{s.name}</code></td>
                    <td style={td}>{s.label}</td>
                    <td style={td}>{s.terminal ? "yes" : "—"}</td>
                    <td style={{ ...td, color: "var(--muted)", maxWidth: "280px" }}>
                      {s.agentInstructions
                        ? s.agentInstructions.split("\n")[0]?.slice(0, 80) + (s.agentInstructions.length > 80 ? "…" : "")
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card style={{ marginTop: "var(--space-4)" }}>
          <h2 style={{ fontSize: "var(--text-base)", fontWeight: 700, marginBottom: "var(--space-3)" }}>Transitions</h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--text-sm)" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={th}>From → To</th>
                  <th style={th}>Label</th>
                  <th style={th}>Required role</th>
                  <th style={th}>Gates (requires)</th>
                </tr>
              </thead>
              <tbody>
                {def.transitions.map((t, i) => (
                  <tr key={`${t.from}-${t.to}-${i}`} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={td}>
                      <code>{t.from}</code> → <code>{t.to}</code>
                    </td>
                    <td style={td}>{t.label ?? "—"}</td>
                    <td style={td}>{t.requiredRole && t.requiredRole !== "any" ? t.requiredRole : "—"}</td>
                    <td style={td}>
                      {t.requires && t.requires.length > 0 ? (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem" }}>
                          {t.requires.map((r) => (
                            <span key={r} style={pill}>
                              {ruleLabelById.get(r) ?? r}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span style={{ color: "var(--muted)" }}>none</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card style={{ marginTop: "var(--space-4)" }}>
          <h2 style={{ fontSize: "var(--text-base)", fontWeight: 700, marginBottom: "var(--space-2)" }}>Available gates</h2>
          <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", marginBottom: "var(--space-3)" }}>
            Built-in precondition rules the backend knows about. Toggling these per
            transition will become possible in the next UI iteration.
          </p>
          <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
            {rules.map((r) => (
              <li key={r.id} style={{ marginBottom: "var(--space-2)" }}>
                <strong>{r.label}</strong> <code style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>({r.id})</code>
                <div style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>{r.description}</div>
              </li>
            ))}
          </ul>
        </Card>
      </main>
    </>
  );
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.75rem",
  fontWeight: 600,
  color: "var(--muted)",
  fontSize: "var(--text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const td: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  verticalAlign: "top",
};

const pill: React.CSSProperties = {
  display: "inline-block",
  padding: "0.125rem 0.5rem",
  borderRadius: "999px",
  background: "color-mix(in srgb, var(--primary, #3b82f6) 15%, transparent)",
  color: "var(--primary, #3b82f6)",
  fontSize: "var(--text-xs)",
  fontWeight: 600,
};
