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

// ── Pure helpers (extracted for testability + reuse) ────────────────────────

const STATE_NAME_RE = /^[a-z0-9_]+$/;

function cloneDefinition(def: WorkflowDefinition): WorkflowDefinition {
  return {
    initialState: def.initialState,
    states: def.states.map((s) => ({ ...s })),
    transitions: def.transitions.map((t) => ({
      ...t,
      ...(t.requires ? { requires: [...t.requires] } : {}),
    })),
  };
}

function sameRequires(a: string[] | undefined, b: string[] | undefined): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  const bs = new Set(bb);
  return aa.every((x) => bs.has(x));
}

function definitionsEqual(a: WorkflowDefinition, b: WorkflowDefinition): boolean {
  if (a.initialState !== b.initialState) return false;
  if (a.states.length !== b.states.length) return false;
  for (let i = 0; i < a.states.length; i++) {
    const sa = a.states[i]!;
    const sb = b.states[i]!;
    if (
      sa.name !== sb.name ||
      sa.label !== sb.label ||
      sa.terminal !== sb.terminal ||
      (sa.agentInstructions ?? "") !== (sb.agentInstructions ?? "")
    ) {
      return false;
    }
  }
  if (a.transitions.length !== b.transitions.length) return false;
  for (let i = 0; i < a.transitions.length; i++) {
    const ta = a.transitions[i]!;
    const tb = b.transitions[i]!;
    if (
      ta.from !== tb.from ||
      ta.to !== tb.to ||
      (ta.label ?? "") !== (tb.label ?? "") ||
      (ta.requiredRole ?? "any") !== (tb.requiredRole ?? "any") ||
      !sameRequires(ta.requires, tb.requires)
    ) {
      return false;
    }
  }
  return true;
}

interface ValidationResult {
  errors: string[];
  warnings: string[];
}

/**
 * BFS reachability from the initial state over the transition graph.
 * Returns the set of states that CAN be reached. Used by both the
 * reachability warning computation and the test suite.
 */
export function reachableStates(def: WorkflowDefinition): Set<string> {
  const reachable = new Set<string>();
  if (!def.states.some((s) => s.name === def.initialState)) return reachable;
  const queue: string[] = [def.initialState];
  reachable.add(def.initialState);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const t of def.transitions) {
      if (t.from === current && !reachable.has(t.to)) {
        reachable.add(t.to);
        queue.push(t.to);
      }
    }
  }
  return reachable;
}

export interface ReachabilityReport {
  unreachable: string[];
  deadEnds: string[];
  orphans: string[];
}

/**
 * Categorize states by reachability problems:
 *  - unreachable: cannot be reached from the initial state
 *  - deadEnds: non-terminal with no outgoing transition (task gets stuck)
 *  - orphans: no incoming transition and not the initial state
 * All three are informational — they're warnings, not errors. A user can
 * save a workflow with warnings; the backend does not check reachability.
 */
export function computeReachability(def: WorkflowDefinition): ReachabilityReport {
  const reachable = reachableStates(def);
  const outgoing = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const s of def.states) {
    outgoing.set(s.name, 0);
    incoming.set(s.name, 0);
  }
  for (const t of def.transitions) {
    outgoing.set(t.from, (outgoing.get(t.from) ?? 0) + 1);
    incoming.set(t.to, (incoming.get(t.to) ?? 0) + 1);
  }

  const unreachable: string[] = [];
  const deadEnds: string[] = [];
  const orphans: string[] = [];
  for (const s of def.states) {
    if (!reachable.has(s.name)) unreachable.push(s.name);
    if (!s.terminal && (outgoing.get(s.name) ?? 0) === 0) deadEnds.push(s.name);
    if ((incoming.get(s.name) ?? 0) === 0 && s.name !== def.initialState) {
      orphans.push(s.name);
    }
  }
  return { unreachable, deadEnds, orphans };
}

export function validateDefinition(def: WorkflowDefinition): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Name uniqueness + format
  const seen = new Set<string>();
  for (const s of def.states) {
    if (!s.name) {
      errors.push("State name cannot be empty.");
      continue;
    }
    if (!STATE_NAME_RE.test(s.name)) {
      errors.push(`State name "${s.name}" must match [a-z0-9_]+ (lowercase, digits, underscore).`);
    }
    if (seen.has(s.name)) {
      errors.push(`Duplicate state name: "${s.name}".`);
    }
    seen.add(s.name);
    if (!s.label.trim()) {
      errors.push(`State "${s.name}" has no label.`);
    }
  }

  // initialState must reference an existing state
  if (!seen.has(def.initialState)) {
    errors.push(`Initial state "${def.initialState}" is not in the states list.`);
  }

  // Transitions must reference existing states
  const seenPairs = new Set<string>();
  for (const t of def.transitions) {
    if (!seen.has(t.from)) {
      errors.push(`Transition references missing "from" state: "${t.from}" → "${t.to}".`);
    }
    if (!seen.has(t.to)) {
      errors.push(`Transition references missing "to" state: "${t.from}" → "${t.to}".`);
    }
    const key = `${t.from}→${t.to}`;
    if (seenPairs.has(key)) {
      errors.push(`Duplicate transition: ${key}.`);
    }
    seenPairs.add(key);
  }

  // At least one terminal state — warning only, not blocking
  if (!def.states.some((s) => s.terminal)) {
    warnings.push("No terminal state is marked. Tasks will never reach a 'done' state.");
  }

  // Reachability warnings — only meaningful when the structural errors
  // above don't already make the graph incoherent.
  if (errors.length === 0) {
    const { unreachable, deadEnds, orphans } = computeReachability(def);
    for (const name of unreachable) {
      warnings.push(`State "${name}" is unreachable from the initial state.`);
    }
    for (const name of deadEnds) {
      warnings.push(`State "${name}" is a non-terminal dead end (no outgoing transitions).`);
    }
    for (const name of orphans) {
      warnings.push(`State "${name}" has no incoming transition.`);
    }
  }

  return { errors, warnings };
}

const ROLE_OPTIONS = ["any", "ADMIN", "HUMAN_MEMBER", "REVIEWER"] as const;

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

        {/* ── States ────────────────────────────────────────────────────── */}
        <Card style={{ marginTop: "var(--space-4)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "var(--space-3)" }}>
            <h2 style={{ fontSize: "var(--text-base)", fontWeight: 700 }}>States</h2>
            {canEdit && (
              <Button type="button" variant="secondary" onClick={addState} disabled={saving}>
                + Add state
              </Button>
            )}
          </div>

          <div style={{ marginBottom: "var(--space-3)" }}>
            <label style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginRight: "0.5rem" }}>
              Initial state:
            </label>
            {canEdit ? (
              <select
                value={activeDef.initialState}
                onChange={(e) => setInitialState(e.target.value)}
                disabled={saving}
                style={{ padding: "0.25rem 0.5rem", fontSize: "var(--text-sm)" }}
              >
                {activeDef.states.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            ) : (
              <code>{activeDef.initialState}</code>
            )}
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--text-sm)" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={th}>Name</th>
                  <th style={th}>Label</th>
                  <th style={th}>Terminal</th>
                  <th style={th}>Agent instructions</th>
                  {canEdit && <th style={th}></th>}
                </tr>
              </thead>
              <tbody>
                {activeDef.states.map((s, i) => {
                  const isExpanded = expandedInstructions.has(i);
                  return (
                    <tr key={`${i}-${s.name}`} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={td}>
                        {canEdit ? (
                          <input
                            type="text"
                            value={s.name}
                            onChange={(e) => updateStateField(i, "name", e.target.value)}
                            disabled={saving}
                            style={inlineInput}
                          />
                        ) : (
                          <code>{s.name}</code>
                        )}
                      </td>
                      <td style={td}>
                        {canEdit ? (
                          <input
                            type="text"
                            value={s.label}
                            onChange={(e) => updateStateField(i, "label", e.target.value)}
                            disabled={saving}
                            style={inlineInput}
                          />
                        ) : (
                          s.label
                        )}
                      </td>
                      <td style={td}>
                        {canEdit ? (
                          <input
                            type="checkbox"
                            checked={s.terminal}
                            onChange={(e) => updateStateField(i, "terminal", e.target.checked)}
                            disabled={saving}
                          />
                        ) : s.terminal ? (
                          "yes"
                        ) : (
                          "—"
                        )}
                      </td>
                      <td style={{ ...td, maxWidth: "360px" }}>
                        {canEdit ? (
                          isExpanded ? (
                            <div>
                              <textarea
                                value={s.agentInstructions ?? ""}
                                onChange={(e) => updateStateField(i, "agentInstructions", e.target.value)}
                                disabled={saving}
                                rows={4}
                                style={{ width: "100%", fontSize: "var(--text-xs)", fontFamily: "inherit" }}
                              />
                              <button
                                type="button"
                                onClick={() => toggleInstructionsExpanded(i)}
                                style={linkButton}
                              >
                                Collapse
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => toggleInstructionsExpanded(i)}
                              style={{ ...linkButton, textAlign: "left", width: "100%" }}
                            >
                              {s.agentInstructions
                                ? s.agentInstructions.split("\n")[0]?.slice(0, 80) +
                                  (s.agentInstructions.length > 80 ? "…" : "")
                                : "Add instructions…"}
                            </button>
                          )
                        ) : (
                          <span style={{ color: "var(--muted)" }}>
                            {s.agentInstructions
                              ? s.agentInstructions.split("\n")[0]?.slice(0, 80) +
                                (s.agentInstructions.length > 80 ? "…" : "")
                              : "—"}
                          </span>
                        )}
                      </td>
                      {canEdit && (
                        <td style={{ ...td, width: "1%", whiteSpace: "nowrap" }}>
                          <button
                            type="button"
                            onClick={() => removeState(i)}
                            disabled={saving}
                            style={{ ...linkButton, color: "#dc2626" }}
                            title="Remove state"
                          >
                            ✕
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        {/* ── Transitions ──────────────────────────────────────────────── */}
        <Card style={{ marginTop: "var(--space-4)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "var(--space-3)" }}>
            <h2 style={{ fontSize: "var(--text-base)", fontWeight: 700 }}>Transitions</h2>
            {canEdit && (
              <Button type="button" variant="secondary" onClick={addTransition} disabled={saving}>
                + Add transition
              </Button>
            )}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--text-sm)" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={th}>From</th>
                  <th style={th}>To</th>
                  <th style={th}>Label</th>
                  <th style={th}>Required role</th>
                  <th style={th}>Gates (requires)</th>
                  {canEdit && <th style={th}></th>}
                </tr>
              </thead>
              <tbody>
                {activeDef.transitions.map((t, i) => {
                  const activeRequires = t.requires ?? [];
                  return (
                    <tr key={`transition-${i}`} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={td}>
                        {canEdit ? (
                          <select
                            value={t.from}
                            onChange={(e) => updateTransitionField(i, "from", e.target.value)}
                            disabled={saving}
                            style={inlineSelect}
                          >
                            {activeDef.states.map((s) => (
                              <option key={s.name} value={s.name}>
                                {s.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <code>{t.from}</code>
                        )}
                      </td>
                      <td style={td}>
                        {canEdit ? (
                          <select
                            value={t.to}
                            onChange={(e) => updateTransitionField(i, "to", e.target.value)}
                            disabled={saving}
                            style={inlineSelect}
                          >
                            {activeDef.states.map((s) => (
                              <option key={s.name} value={s.name}>
                                {s.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <code>{t.to}</code>
                        )}
                      </td>
                      <td style={td}>
                        {canEdit ? (
                          <input
                            type="text"
                            value={t.label ?? ""}
                            onChange={(e) => updateTransitionField(i, "label", e.target.value)}
                            disabled={saving}
                            placeholder="(optional)"
                            style={inlineInput}
                          />
                        ) : (
                          t.label ?? "—"
                        )}
                      </td>
                      <td style={td}>
                        {canEdit ? (
                          <select
                            value={t.requiredRole ?? "any"}
                            onChange={(e) => updateTransitionField(i, "requiredRole", e.target.value)}
                            disabled={saving}
                            style={inlineSelect}
                          >
                            {ROLE_OPTIONS.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                        ) : t.requiredRole && t.requiredRole !== "any" ? (
                          t.requiredRole
                        ) : (
                          "—"
                        )}
                      </td>
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
                                  onChange={(e) => toggleRule(i, r.id, e.target.checked)}
                                  disabled={saving}
                                />
                                <span>{r.label}</span>
                                <code style={{ color: "var(--muted)" }}>({r.id})</code>
                              </label>
                            ))}
                            {activeRequires
                              .filter((r) => !rules.some((x) => x.id === r))
                              .map((r) => (
                                <span
                                  key={r}
                                  style={{ ...pill, background: "rgba(239, 68, 68, 0.15)", color: "#dc2626" }}
                                >
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
                      {canEdit && (
                        <td style={{ ...td, width: "1%", whiteSpace: "nowrap" }}>
                          <button
                            type="button"
                            onClick={() => removeTransition(i)}
                            disabled={saving}
                            style={{ ...linkButton, color: "#dc2626" }}
                            title="Remove transition"
                          >
                            ✕
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
                {activeDef.transitions.length === 0 && (
                  <tr>
                    <td
                      colSpan={canEdit ? 6 : 5}
                      style={{ ...td, color: "var(--muted)", textAlign: "center", padding: "var(--space-3)" }}
                    >
                      No transitions defined. Tasks will not be able to change status.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

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

// ── Styles ──────────────────────────────────────────────────────────────────

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

const inlineInput: React.CSSProperties = {
  width: "100%",
  padding: "0.25rem 0.5rem",
  fontSize: "var(--text-sm)",
  fontFamily: "inherit",
  background: "var(--input-bg, transparent)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm, 4px)",
};

const inlineSelect: React.CSSProperties = {
  padding: "0.25rem 0.5rem",
  fontSize: "var(--text-sm)",
  fontFamily: "inherit",
  background: "var(--input-bg, transparent)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm, 4px)",
};

const linkButton: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  color: "var(--primary, #3b82f6)",
  cursor: "pointer",
  fontSize: "var(--text-xs)",
  textDecoration: "underline",
};
