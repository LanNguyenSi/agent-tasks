"use client";

/**
 * Workflow & Gates — viewer + transition-gate editor (Tasks 2 + 3/5).
 *
 * Shows the effective workflow for a single project (custom Workflow row
 * or hardcoded system default). Admins on a default-workflow project see
 * a "Customize" button that forks the default into a custom row. Once a
 * custom row exists, admins additionally see a gates editor — checkboxes
 * per existing transition that toggle the `requires` array, saved via
 * PUT /api/workflows/:id. State / transition add-remove-rename is still
 * out of scope (tasks 4 + 5).
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
  resetProjectWorkflow,
  updateWorkflow,
  type EffectiveWorkflow,
  type Project,
  type Team,
  type User,
  type WorkflowDefinition,
  type WorkflowRule,
  type WorkflowTransition,
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

  // Gates editor state — a per-transition `requires` override map keyed by
  // the transition's from→to pair. A transition that has never been touched
  // reads its gates from the loaded workflow; a touched transition reads
  // from `gateOverrides`. This keeps "dirty" detection simple and allows a
  // Cancel button to revert by clearing the map.
  const [gateOverrides, setGateOverrides] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const [savedBanner, setSavedBanner] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

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
      setGateOverrides({});
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCustomizing(false);
    }
  }

  // Stable key for a transition in the overrides map. from→to pairs are
  // unique per workflow per the backend's zod validation, so this is safe.
  function transitionKey(t: { from: string; to: string }): string {
    return `${t.from}→${t.to}`;
  }

  // The effective requires array for a transition: override if present,
  // otherwise the value loaded from the server.
  function currentRequires(t: WorkflowTransition): string[] {
    const key = transitionKey(t);
    return gateOverrides[key] ?? t.requires ?? [];
  }

  function sameRequires(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const bs = new Set(b);
    return a.every((x) => bs.has(x));
  }

  function toggleRule(t: WorkflowTransition, ruleId: string, on: boolean) {
    const key = transitionKey(t);
    // Seed from currentRequires() — NOT from t.requires directly — so any
    // unknown rule names already stored on the transition survive into the
    // override and are preserved on save. Dropping this seeding would
    // silently wipe forward-compat rules the frontend doesn't know about.
    const current = new Set(currentRequires(t));
    if (on) current.add(ruleId);
    else current.delete(ruleId);
    const next = Array.from(current);
    const original = t.requires ?? [];
    setGateOverrides((prev) => {
      // If the user toggled back to the server's original state, drop the
      // override entry entirely — otherwise the dirty indicator and Save
      // button would lie ("1 unsaved change" with no actual diff).
      if (sameRequires(next, original)) {
        const { [key]: _removed, ...rest } = prev;
        void _removed;
        return rest;
      }
      return { ...prev, [key]: next };
    });
    setSavedBanner(false);
  }

  const isDirty = Object.keys(gateOverrides).length > 0;

  function handleCancel() {
    setGateOverrides({});
    setError(null);
    setSavedBanner(false);
  }

  async function handleSave() {
    if (!workflow || !workflow.workflowId) return;
    setSaving(true);
    setError(null);
    try {
      const nextDef: WorkflowDefinition = {
        ...workflow.definition,
        transitions: workflow.definition.transitions.map((t) => {
          const key = transitionKey(t);
          if (!(key in gateOverrides)) return t;
          const requires = gateOverrides[key] ?? [];
          // Strip the field entirely when empty — keeps the stored shape
          // clean and matches the no-requires convention.
          const { requires: _drop, ...rest } = t;
          void _drop;
          return requires.length > 0 ? { ...rest, requires } : rest;
        }),
      };
      await updateWorkflow(workflow.workflowId, { definition: nextDef });
      // Reload to pick up the canonical shape and any server-side
      // normalization (e.g. unknown rules being logged).
      const refreshed = await getEffectiveWorkflow(projectId ?? "");
      setWorkflow(refreshed);
      setGateOverrides({});
      setSavedBanner(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (!projectId) return;
    setResetting(true);
    setError(null);
    try {
      const next = await resetProjectWorkflow(projectId);
      setWorkflow(next);
      setGateOverrides({});
      setConfirmingReset(false);
      setSavedBanner(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setResetting(false);
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

        <AlertBanner tone={isDefault ? "info" : "success"} title={
          isDefault
            ? "Using system default"
            : isDirty
              ? "Custom workflow — unsaved changes"
              : "Custom workflow"
        }>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
            <span>
              {isDefault
                ? "This project inherits the built-in default workflow. It applies to every project that hasn't defined its own."
                : isAdmin
                  ? "Toggle gates per transition below, then click Save. Use Reset to go back to the system default."
                  : "This project has its own workflow. Only team admins can edit gates."}
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

        {savedBanner && (
          <AlertBanner tone="success" title="Saved">
            Gate changes have been persisted. New task transitions will be evaluated
            against the updated rules.
          </AlertBanner>
        )}

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
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "var(--space-3)" }}>
            <h2 style={{ fontSize: "var(--text-base)", fontWeight: 700 }}>Transitions</h2>
            {isDirty && (
              <span style={pillDirty}>
                {Object.keys(gateOverrides).length} unsaved change{Object.keys(gateOverrides).length === 1 ? "" : "s"}
              </span>
            )}
          </div>
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
                {def.transitions.map((t, i) => {
                  const activeRequires = currentRequires(t);
                  const canEdit = !isDefault && isAdmin;
                  return (
                    <tr key={`${t.from}-${t.to}-${i}`} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={td}>
                        <code>{t.from}</code> → <code>{t.to}</code>
                      </td>
                      <td style={td}>{t.label ?? "—"}</td>
                      <td style={td}>{t.requiredRole && t.requiredRole !== "any" ? t.requiredRole : "—"}</td>
                      <td style={td}>
                        {canEdit ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                            {rules.map((r) => (
                              <label
                                key={r.id}
                                style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "var(--text-xs)" }}
                              >
                                <input
                                  type="checkbox"
                                  checked={activeRequires.includes(r.id)}
                                  onChange={(e) => toggleRule(t, r.id, e.target.checked)}
                                  disabled={saving}
                                />
                                <span>{r.label}</span>
                                <code style={{ color: "var(--muted)" }}>({r.id})</code>
                              </label>
                            ))}
                            {/* Preserve any unknown rule names (forward-compat)
                                so a save doesn't drop them even though we
                                don't render a checkbox for them. */}
                            {activeRequires
                              .filter((r) => !rules.some((x) => x.id === r))
                              .map((r) => (
                                <span key={r} style={{ ...pill, background: "rgba(239, 68, 68, 0.15)", color: "#dc2626" }}>
                                  {r} (unknown)
                                </span>
                              ))}
                          </div>
                        ) : activeRequires.length > 0 ? (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem" }}>
                            {activeRequires.map((r) => (
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
                  );
                })}
              </tbody>
            </table>
          </div>

          {!isDefault && isAdmin && (
            <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-4)", flexWrap: "wrap", alignItems: "center" }}>
              <Button type="button" onClick={() => void handleSave()} disabled={!isDirty || saving} loading={saving}>
                Save changes
              </Button>
              <Button type="button" variant="secondary" onClick={handleCancel} disabled={!isDirty || saving}>
                Cancel
              </Button>
              <div style={{ flex: 1 }} />
              {!confirmingReset ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setConfirmingReset(true)}
                  disabled={saving || resetting}
                >
                  Reset to default
                </Button>
              ) : (
                <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
                    Drop the custom workflow and revert to the system default?
                    {isDirty && " Unsaved gate edits will be lost."}
                  </span>
                  <Button type="button" onClick={() => void handleReset()} disabled={resetting} loading={resetting}>
                    Yes, reset
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => setConfirmingReset(false)} disabled={resetting}>
                    No
                  </Button>
                </div>
              )}
            </div>
          )}
        </Card>

        <Card style={{ marginTop: "var(--space-4)" }}>
          <h2 style={{ fontSize: "var(--text-base)", fontWeight: 700, marginBottom: "var(--space-2)" }}>Available gates</h2>
          <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", marginBottom: "var(--space-3)" }}>
            Built-in precondition rules the backend knows about. Toggle them per
            transition in the table above (admin + custom workflow required).
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

const pillDirty: React.CSSProperties = {
  display: "inline-block",
  padding: "0.125rem 0.5rem",
  borderRadius: "999px",
  background: "rgba(250, 204, 21, 0.2)",
  color: "#a16207",
  fontSize: "var(--text-xs)",
  fontWeight: 600,
};
