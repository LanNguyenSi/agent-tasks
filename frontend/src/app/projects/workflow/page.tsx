"use client";

/**
 * Workflow & Gates — full editor (Tasks 2–5).
 *
 * Single-draft architecture: any edit (gate toggle, state or transition
 * add/edit/rename/remove, initialState change) goes into `draft`, a
 * deep clone of the loaded `workflow.definition`. `activeDef` reads
 * from the draft when dirty, else from the workflow. Save PUTs the
 * full draft; Cancel nulls it; Reset drops the entire custom Workflow
 * row. State renames propagate into transitions and initialState in
 * the same mutation.
 *
 * Validation runs client-side (structural errors + reachability
 * warnings) and is mirrored by the backend's `workflowDefinitionSchema`
 * — the frontend is UX, the backend is the source of truth.
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
  type WorkflowState,
  type WorkflowTransition,
} from "../../../lib/api";
import AppHeader from "../../../components/AppHeader";
import AlertBanner from "../../../components/ui/AlertBanner";
import { Button } from "../../../components/ui/Button";
import Card from "../../../components/ui/Card";
import {
  cloneDefinition,
  definitionsEqual,
  STATE_NAME_RE,
  validateDefinition,
  type ValidationResult,
} from "../../../lib/workflow-draft";
import { StatesTable } from "./_components/StatesTable";
import { TransitionsTable } from "./_components/TransitionsTable";

// ── Page ────────────────────────────────────────────────────────────────────

export default function WorkflowEditorPage() {
  const router = useRouter();
  // `undefined` = URL not read yet; `""` = read but missing.
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

  // Single draft of the workflow definition. Null means "not editing" and
  // the page renders the canonical workflow.definition. Any mutation
  // (gate toggle, state edit, rename, etc.) replaces this draft; a
  // matched-original check clears it back to null automatically.
  const [draft, setDraft] = useState<WorkflowDefinition | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedBanner, setSavedBanner] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  // Which state rows have their agent-instructions textarea expanded.
  // Keyed by row index (not name) so that renaming a state doesn't silently
  // collapse its open textarea.
  const [expandedInstructions, setExpandedInstructions] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (projectId === undefined) return;
    if (projectId === "") {
      setError("Missing projectId query parameter. Link to this page with ?projectId=<uuid>.");
      setLoading(false);
      return;
    }
    const id = projectId;
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

  const activeDef = draft ?? workflow?.definition ?? null;
  const isDirty = draft !== null;
  const validation: ValidationResult = useMemo(
    () => (activeDef ? validateDefinition(activeDef) : { errors: [], warnings: [] }),
    [activeDef],
  );

  // Cmd/Ctrl+S triggers Save when there's a dirty draft. Matches the
  // standard "editor save" shortcut so admins don't have to reach for the
  // mouse to commit. Always `preventDefault()` when we're the active
  // editor — even on a no-op — so the browser's native "Save Page As"
  // dialog doesn't pop up mid-edit.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!((e.metaKey || e.ctrlKey) && e.key === "s")) return;
      e.preventDefault();
      if (draft === null || saving || validation.errors.length > 0) return;
      void handleSave();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // handleSave closes over the same state listed here; adding it to
    // deps would cause re-registration on every render without changing
    // behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, saving, validation.errors.length, validation.warnings.length]);

  /** True only when a state in the draft has a different name than the
   * same row in the canonical workflow, or the row count changed. The
   * rename warning banner only fires in that case — not for every
   * gate-toggle or label-edit dirty state. */
  const hasRename = useMemo(() => {
    if (!draft || !workflow) return false;
    if (draft.states.length !== workflow.definition.states.length) return true;
    return draft.states.some((s, i) => workflow.definition.states[i]?.name !== s.name);
  }, [draft, workflow]);

  // ── Draft mutation helpers ─────────────────────────────────────────────────

  /** Apply a mutation to the draft. Clears the draft back to null if the
   *  result is structurally equal to the server's canonical definition. */
  function mutateDraft(mutator: (d: WorkflowDefinition) => WorkflowDefinition) {
    if (!workflow) return;
    const next = mutator(cloneDefinition(draft ?? workflow.definition));
    setSavedBanner(false);
    setError(null); // any successful mutation clears stale inline errors
    if (definitionsEqual(next, workflow.definition)) {
      setDraft(null);
    } else {
      setDraft(next);
    }
  }

  function toggleRule(transitionIndex: number, ruleId: string, on: boolean) {
    mutateDraft((d) => {
      const t = d.transitions[transitionIndex];
      if (!t) return d;
      const current = new Set(t.requires ?? []);
      if (on) current.add(ruleId);
      else current.delete(ruleId);
      const nextRequires = Array.from(current);
      if (nextRequires.length === 0) {
        delete t.requires;
      } else {
        t.requires = nextRequires;
      }
      return d;
    });
  }

  function updateStateField<K extends keyof WorkflowState>(
    index: number,
    field: K,
    value: WorkflowState[K],
  ) {
    mutateDraft((d) => {
      const s = d.states[index];
      if (!s) return d;

      if (field === "name" && typeof value === "string" && value !== s.name) {
        const oldName = s.name;
        const newName = value;
        // Propagate the rename into transitions + initialState ONLY when
        // the new name is (a) structurally valid and (b) does not collide
        // with another existing state. Otherwise — e.g. transient values
        // during typing, empty strings, or attempts to merge with an
        // existing name — we just write the name without rewiring
        // references. `validateDefinition` will then flag the invalid
        // or duplicate state, save is blocked, and the other transitions
        // keep pointing at their original endpoints. This prevents a
        // silent transition-hijack bug where a mid-keystroke value (e.g.
        // first typing "Y" en route to "Y2") would merge transitions
        // belonging to two different states.
        const nameIsValid = STATE_NAME_RE.test(newName);
        const nameCollides = d.states.some(
          (other, j) => j !== index && other.name === newName,
        );
        if (nameIsValid && !nameCollides) {
          for (const t of d.transitions) {
            if (t.from === oldName) t.from = newName;
            if (t.to === oldName) t.to = newName;
          }
          if (d.initialState === oldName) d.initialState = newName;
        }
      }

      s[field] = value;
      return d;
    });
  }

  function addState() {
    mutateDraft((d) => {
      // Generate a unique placeholder name
      let n = 1;
      while (d.states.some((s) => s.name === `new_state_${n}`)) n += 1;
      d.states.push({
        name: `new_state_${n}`,
        label: "New state",
        terminal: false,
      });
      return d;
    });
  }

  /**
   * Remove a state. Blocked (error-only, no mutation) if the state is
   * referenced by any transition or is the current initialState — the user
   * must remove those transitions first or reassign initialState.
   */
  function removeState(index: number) {
    if (!activeDef) return;
    const s = activeDef.states[index];
    if (!s) return;

    const refs = activeDef.transitions.filter((t) => t.from === s.name || t.to === s.name);
    if (refs.length > 0) {
      setError(
        `Cannot remove state "${s.name}": ${refs.length} transition(s) still reference it. ` +
          `Remove those transitions first (or rewire them to a different state).`,
      );
      return;
    }
    if (activeDef.initialState === s.name) {
      setError(
        `Cannot remove state "${s.name}": it is the initial state. Change the initial state first.`,
      );
      return;
    }
    mutateDraft((d) => {
      d.states.splice(index, 1);
      return d;
    });
  }

  function setInitialState(name: string) {
    mutateDraft((d) => {
      d.initialState = name;
      return d;
    });
  }

  function addTransition() {
    if (!activeDef || activeDef.states.length < 1) return;
    mutateDraft((d) => {
      // Try to pick a (from, to) pair that isn't already present, so the
      // new row doesn't immediately block Save with a duplicate error.
      // Fall back to a self-loop on the initial state when every pair is
      // already taken.
      const existing = new Set(d.transitions.map((t) => `${t.from}→${t.to}`));
      let pickedFrom = d.initialState;
      let pickedTo = pickedFrom;
      outer: for (const fromState of d.states) {
        for (const toState of d.states) {
          if (!existing.has(`${fromState.name}→${toState.name}`)) {
            pickedFrom = fromState.name;
            pickedTo = toState.name;
            break outer;
          }
        }
      }
      d.transitions.push({
        from: pickedFrom,
        to: pickedTo,
        label: "",
        requiredRole: "any",
      });
      return d;
    });
  }

  function removeTransition(index: number) {
    mutateDraft((d) => {
      d.transitions.splice(index, 1);
      return d;
    });
  }

  function updateTransitionField<K extends keyof WorkflowTransition>(
    index: number,
    field: K,
    value: WorkflowTransition[K],
  ) {
    mutateDraft((d) => {
      const t = d.transitions[index];
      if (!t) return d;
      t[field] = value;
      return d;
    });
  }

  function toggleInstructionsExpanded(index: number) {
    setExpandedInstructions((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  // ── Network handlers ──────────────────────────────────────────────────────

  async function handleCustomize() {
    if (!projectId) return;
    setCustomizing(true);
    setError(null);
    try {
      const next = await customizeProjectWorkflow(projectId);
      setWorkflow(next);
      setDraft(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCustomizing(false);
    }
  }

  function handleCancel() {
    setDraft(null);
    setError(null);
    setSavedBanner(false);
    setExpandedInstructions(new Set());
  }

  async function handleSave() {
    if (!workflow || !workflow.workflowId || !draft) return;
    if (validation.errors.length > 0) {
      setError("Fix validation errors before saving.");
      return;
    }
    // Reachability + terminal-state warnings are non-blocking but
    // user-visible for a reason — ask for explicit confirmation so a
    // stray Cmd+S can't silently persist a broken graph.
    if (validation.warnings.length > 0) {
      const ok = window.confirm(
        `This workflow has ${validation.warnings.length} warning(s) (unreachable states, dead ends, or missing terminal). Save anyway?`,
      );
      if (!ok) return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateWorkflow(workflow.workflowId, { definition: draft });
      if (!projectId) return;
      const refreshed = await getEffectiveWorkflow(projectId);
      setWorkflow(refreshed);
      setDraft(null);
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
      setDraft(null);
      setConfirmingReset(false);
      setSavedBanner(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setResetting(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

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

  if (!workflow || !project || !activeDef) return null;

  const isDefault = workflow.source === "default";
  const canEdit = !isDefault && isAdmin;

  return (
    <>
      <AppHeader user={user ? { login: user.login, avatarUrl: user.avatarUrl } : null} />
      <main style={{ maxWidth: "960px", margin: "0 auto", padding: "var(--space-6) var(--space-4)" }}>
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

        <AlertBanner
          tone={isDefault ? "info" : "success"}
          title={
            isDefault
              ? "Using system default"
              : isDirty
                ? "Custom workflow — unsaved changes"
                : "Custom workflow"
          }
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
            <span>
              {isDefault
                ? "This project inherits the built-in default workflow. It applies to every project that hasn't defined its own."
                : canEdit
                  ? "Edit states and gates below, then click Save. Use Reset to drop the custom workflow entirely."
                  : "This project has its own workflow. Only team admins can edit."}
            </span>
            {isDefault && isAdmin && (
              <Button type="button" onClick={() => void handleCustomize()} disabled={customizing} loading={customizing}>
                Customize this workflow
              </Button>
            )}
            {isDefault && !isAdmin && (
              <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>Only team admins can customize.</span>
            )}
          </div>
        </AlertBanner>

        {savedBanner && (
          <AlertBanner tone="success" title="Saved">
            Workflow changes have been persisted.
          </AlertBanner>
        )}

        {canEdit && isDirty && validation.errors.length > 0 && (
          <AlertBanner tone="danger" title={`Validation errors (${validation.errors.length})`}>
            <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
              {validation.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </AlertBanner>
        )}

        {canEdit && isDirty && validation.warnings.length > 0 && (
          <AlertBanner tone="warning" title={`Warnings (${validation.warnings.length})`}>
            <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
              {validation.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </AlertBanner>
        )}

        {error && (
          <AlertBanner tone="danger" title="Error">
            {error}
          </AlertBanner>
        )}

        {canEdit && hasRename && (
          <AlertBanner tone="info" title="Rename warning">
            You renamed or removed at least one state. Existing tasks currently in the
            old state will have a status string that no longer matches any workflow
            state. Transition attempts on those tasks will fail until an admin
            force-transitions or the task is manually re-labeled. Migration is not
            automatic.
          </AlertBanner>
        )}

        <StatesTable
          def={activeDef}
          canEdit={canEdit}
          saving={saving}
          expandedInstructions={expandedInstructions}
          onAddState={addState}
          onRemoveState={removeState}
          onUpdateStateField={updateStateField}
          onSetInitialState={setInitialState}
          onToggleInstructionsExpanded={toggleInstructionsExpanded}
        />

        <TransitionsTable
          def={activeDef}
          rules={rules}
          ruleLabelById={ruleLabelById}
          canEdit={canEdit}
          saving={saving}
          onAddTransition={addTransition}
          onRemoveTransition={removeTransition}
          onUpdateTransitionField={updateTransitionField}
          onToggleRule={toggleRule}
        />

        {/* ── Action bar ───────────────────────────────────────────────── */}
        {canEdit && (
          <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-4)", flexWrap: "wrap", alignItems: "center" }}>
            <Button
              type="button"
              onClick={() => void handleSave()}
              disabled={!isDirty || saving || validation.errors.length > 0}
              loading={saving}
            >
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
                  {isDirty && " Unsaved edits will be lost."}
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

        {/* ── Gate reference ───────────────────────────────────────────── */}
        <Card style={{ marginTop: "var(--space-4)" }}>
          <h2 style={{ fontSize: "var(--text-base)", fontWeight: 700, marginBottom: "var(--space-2)" }}>
            Available gates
          </h2>
          <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", marginBottom: "var(--space-3)" }}>
            Built-in precondition rules the backend knows about. Toggle them per transition
            in the table above (admin + custom workflow required).
          </p>
          <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
            {rules.map((r) => (
              <li key={r.id} style={{ marginBottom: "var(--space-2)" }}>
                <strong>{r.label}</strong>{" "}
                <code style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>({r.id})</code>
                <div style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>{r.description}</div>
              </li>
            ))}
          </ul>
        </Card>
      </main>
    </>
  );
}

// Styles now live in _components/styles.ts — shared by the page,
// StatesTable, and TransitionsTable so nothing drifts between them.
