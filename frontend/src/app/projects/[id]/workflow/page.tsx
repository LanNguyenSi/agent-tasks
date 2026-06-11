"use client";

/**
 * Workflow & Gates — v2 editor under the /projects/[id] hub layout.
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
 *
 * Stage F2 changes vs. the original /projects/workflow page:
 *  - Route: lives at /projects/[id]/workflow (hub layout, useParams).
 *  - State-diagram strip above tables.
 *  - Tables rebuilt on ui/Table primitive with gate toggle chips.
 *  - Template picker redesigned: descriptions visible, per-slug loading,
 *    "Customize" in its own Card.
 *  - ConfirmDialog replaces window.confirm everywhere.
 *  - Skeletons replace bare "Loading…" text.
 *  - Inline style={{ }} replaced by CSS classes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  applyWorkflowTemplate,
  customizeProjectWorkflow,
  getCurrentUser,
  getEffectiveWorkflow,
  getProject,
  getTeams,
  getWorkflowRules,
  listWorkflowTemplates,
  resetProjectWorkflow,
  updateWorkflow,
  type EffectiveWorkflow,
  type Team,
  type WorkflowDefinition,
  type WorkflowRule,
  type WorkflowState,
  type WorkflowTemplateSummary,
  type WorkflowTransition,
} from "../../../../lib/api";
import AlertBanner from "../../../../components/ui/AlertBanner";
import { Button } from "../../../../components/ui/Button";
import Card from "../../../../components/ui/Card";
import ConfirmDialog from "../../../../components/ui/ConfirmDialog";
import { Skeleton, SkeletonList } from "../../../../components/ui/Skeleton";
import {
  cloneDefinition,
  definitionsEqual,
  STATE_NAME_RE,
  validateDefinition,
  type ValidationResult,
} from "../../../../lib/workflow-draft";
import { WorkflowDiagram, WorkflowDiagramSkeleton } from "./_components/WorkflowDiagram";
import { StatesTable } from "./_components/StatesTable";
import { TransitionsTable } from "./_components/TransitionsTable";

// ── Page ────────────────────────────────────────────────────────────────────

export default function WorkflowEditorPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const router = useRouter();

  const [team, setTeam] = useState<Team | null>(null);
  const [workflow, setWorkflow] = useState<EffectiveWorkflow | null>(null);
  const [rules, setRules] = useState<WorkflowRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [customizing, setCustomizing] = useState(false);
  const [templates, setTemplates] = useState<WorkflowTemplateSummary[]>([]);
  // Track which template slug is currently being applied for per-slug loading.
  const [applyingTemplateSlug, setApplyingTemplateSlug] = useState<string | null>(null);

  // Single draft of the workflow definition. Null = not editing.
  const [draft, setDraft] = useState<WorkflowDefinition | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedBanner, setSavedBanner] = useState(false);
  const [resetting, setResetting] = useState(false);

  // ConfirmDialog states — each dialog independent.
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmSaveWarnings, setConfirmSaveWarnings] = useState(false);
  const [confirmTemplateApply, setConfirmTemplateApply] = useState<string | null>(null);

  // Which state rows have their agent-instructions textarea expanded.
  // Keyed by row index (not name) so renaming a state doesn't collapse it.
  const [expandedInstructions, setExpandedInstructions] = useState<Set<number>>(new Set());

  // Index of the transition row to highlight (driven by diagram arrow clicks).
  const [highlightedTransition, setHighlightedTransition] = useState<number | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [me, proj, teams, wf, catalog, tpls] = await Promise.all([
          getCurrentUser(),
          getProject(projectId),
          getTeams(),
          getEffectiveWorkflow(projectId),
          getWorkflowRules(),
          listWorkflowTemplates(),
        ]);
        if (cancelled) return;
        if (!me) {
          router.replace("/auth");
          return;
        }
        // Identify the team by matching the project's teamId so we get the
        // caller's role for the correct team (not just the first one).
        setTeam(teams.find((t) => t.id === proj.teamId) ?? null);
        setWorkflow(wf);
        setRules(catalog);
        setTemplates(tpls);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
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

  // Cmd/Ctrl+S triggers Save when there's a dirty draft.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!((e.metaKey || e.ctrlKey) && e.key === "s")) return;
      e.preventDefault();
      if (draft === null || saving || validation.errors.length > 0) return;
      if (validation.warnings.length > 0) {
        setConfirmSaveWarnings(true);
        return;
      }
      void doSave();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, saving, validation.errors.length, validation.warnings.length]);

  // ── Draft mutation helpers ─────────────────────────────────────────────────

  function mutateDraft(mutator: (d: WorkflowDefinition) => WorkflowDefinition) {
    if (!workflow) return;
    const next = mutator(cloneDefinition(draft ?? workflow.definition));
    setSavedBanner(false);
    setError(null);
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
        const nameIsValid = STATE_NAME_RE.test(newName);
        const nameCollides = d.states.some((other, j) => j !== index && other.name === newName);
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
      let n = 1;
      while (d.states.some((s) => s.name === `new_state_${n}`)) n += 1;
      d.states.push({ name: `new_state_${n}`, label: "New state", terminal: false });
      return d;
    });
  }

  function removeState(index: number) {
    if (!activeDef) return;
    const s = activeDef.states[index];
    if (!s) return;
    const refs = activeDef.transitions.filter((t) => t.from === s.name || t.to === s.name);
    if (refs.length > 0) {
      setError(
        `Cannot remove state "${s.name}": ${refs.length} transition(s) still reference it. Remove those transitions first.`,
      );
      return;
    }
    if (activeDef.initialState === s.name) {
      setError(`Cannot remove state "${s.name}": it is the initial state. Change the initial state first.`);
      return;
    }
    mutateDraft((d) => { d.states.splice(index, 1); return d; });
  }

  function setInitialState(name: string) {
    mutateDraft((d) => { d.initialState = name; return d; });
  }

  function addTransition() {
    if (!activeDef || activeDef.states.length < 1) return;
    mutateDraft((d) => {
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
      d.transitions.push({ from: pickedFrom, to: pickedTo, label: "", requiredRole: "any" });
      return d;
    });
  }

  function removeTransition(index: number) {
    mutateDraft((d) => { d.transitions.splice(index, 1); return d; });
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

  // ── Diagram arrow click → scroll + highlight ────────────────────────────

  const handleArrowClick = useCallback((transitionIndex: number) => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightedTransition(transitionIndex);
    // Remove highlight after 2.5 s so it doesn't stick.
    highlightTimerRef.current = setTimeout(() => setHighlightedTransition(null), 2500);
  }, []);

  // Cleanup timer on unmount.
  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, []);

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

  async function doApplyTemplate(slug: string) {
    if (!projectId) return;
    setApplyingTemplateSlug(slug);
    setError(null);
    try {
      const next = await applyWorkflowTemplate(projectId, slug);
      setWorkflow(next);
      setDraft(null);
      setSavedBanner(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setApplyingTemplateSlug(null);
      setConfirmTemplateApply(null);
    }
  }

  function handleApplyTemplateClick(slug: string) {
    // If already on a custom workflow, confirm before overwriting.
    if (workflow?.source === "custom") {
      setConfirmTemplateApply(slug);
    } else {
      void doApplyTemplate(slug);
    }
  }

  function handleCancel() {
    setDraft(null);
    setError(null);
    setSavedBanner(false);
    setExpandedInstructions(new Set());
  }

  async function doSave() {
    if (!workflow || !workflow.workflowId || !draft) return;
    if (validation.errors.length > 0) {
      setError("Fix validation errors before saving.");
      return;
    }
    setSaving(true);
    setError(null);
    setConfirmSaveWarnings(false);
    try {
      await updateWorkflow(workflow.workflowId, { definition: draft });
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

  function handleSave() {
    if (validation.warnings.length > 0) {
      setConfirmSaveWarnings(true);
      return;
    }
    void doSave();
  }

  async function handleReset() {
    if (!projectId) return;
    setResetting(true);
    setError(null);
    try {
      const next = await resetProjectWorkflow(projectId);
      setWorkflow(next);
      setDraft(null);
      setConfirmReset(false);
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
      <div role="status" aria-busy="true">
        <span className="sr-only">Loading workflow editor</span>
        {/* Status banner skeleton */}
        <Skeleton height="3.5rem" radius="var(--radius-lg)" />
        {/* State diagram strip skeleton */}
        <WorkflowDiagramSkeleton />
        {/* States table skeleton */}
        <Card className="wf-table-section">
          <div className="wf-table-header">
            <Skeleton width={80} height="1rem" radius="var(--radius-sm)" />
          </div>
          <SkeletonList rows={4} rowHeight="2.5rem" label="Loading states" />
        </Card>
        {/* Transitions table skeleton */}
        <Card className="wf-table-section">
          <div className="wf-table-header">
            <Skeleton width={100} height="1rem" radius="var(--radius-sm)" />
          </div>
          <SkeletonList rows={5} rowHeight="2.5rem" label="Loading transitions" />
        </Card>
      </div>
    );
  }

  if (error && !workflow) {
    return (
      <AlertBanner tone="danger" title="Could not load workflow">
        {error}
      </AlertBanner>
    );
  }

  if (!workflow || !activeDef) return null;

  const isDefault = workflow.source === "default";
  const canEdit = !isDefault && isAdmin;
  const applyingTemplate = applyingTemplateSlug !== null;

  return (
    <>
      {/* ── Status banner ────────────────────────────────────────── */}
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
        {isDefault
          ? "This project inherits the built-in default workflow. It applies to every project that hasn't defined its own."
          : canEdit
            ? "Edit states and gates below, then click Save. Use Reset to drop the custom workflow entirely."
            : "This project has its own workflow. Only team admins can edit."}
        {isDefault && !isAdmin && (
          <span className="wf-table-hint"> Only team admins can customize.</span>
        )}
      </AlertBanner>

      {/* ── Customize / template picker ─────────────────────────── */}
      {isDefault && isAdmin && (
        <Card className="wf-setup-card">
          <div className="wf-setup-row">
            {/* Customize button */}
            <div>
              <p className="wf-setup-section-title">
                Customize for this project
              </p>
              <p className="wf-table-hint">
                Start from the default workflow and make changes specific to this project.
              </p>
              <Button
                type="button"
                onClick={() => void handleCustomize()}
                disabled={customizing || applyingTemplate}
                loading={customizing}
              >
                Customize this workflow
              </Button>
            </div>

            {templates.length > 0 && (
              <>
                <div className="wf-setup-divider" aria-hidden="true">or</div>
                {/* Template list */}
                <div>
                  <p className="wf-setup-section-title">
                    Start from a template
                  </p>
                  <div className="wf-template-list">
                    {templates.map((tpl) => {
                      const isApplying = applyingTemplateSlug === tpl.slug;
                      return (
                        <button
                          key={tpl.slug}
                          type="button"
                          className="wf-template-item"
                          onClick={() => handleApplyTemplateClick(tpl.slug)}
                          disabled={customizing || applyingTemplate}
                          aria-busy={isApplying}
                        >
                          <span className="wf-template-name">
                            {isApplying ? "Applying…" : tpl.name}
                          </span>
                          <span className="wf-template-desc">{tpl.description}</span>
                          <span className="wf-template-meta">
                            {tpl.stateCount} state{tpl.stateCount !== 1 ? "s" : ""}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        </Card>
      )}

      {/* ── Saved banner ─────────────────────────────────────────── */}
      {savedBanner && (
        <AlertBanner tone="success" title="Saved">
          Workflow changes have been persisted.
        </AlertBanner>
      )}

      {/* ── Validation banners ──────────────────────────────────── */}
      {canEdit && isDirty && validation.errors.length > 0 && (
        <AlertBanner tone="danger" title={`Validation errors (${validation.errors.length})`}>
          <ul className="wf-gate-ref-list">
            {validation.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </AlertBanner>
      )}

      {canEdit && isDirty && validation.warnings.length > 0 && (
        <AlertBanner tone="warning" title={`Warnings (${validation.warnings.length})`}>
          <ul className="wf-gate-ref-list">
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

      {/* ── State diagram strip ──────────────────────────────────── */}
      <WorkflowDiagram
        def={activeDef}
        onArrowClick={handleArrowClick}
      />

      {/* ── States table ─────────────────────────────────────────── */}
      <StatesTable
        def={activeDef}
        canEdit={canEdit}
        statesLocked={true}
        saving={saving}
        expandedInstructions={expandedInstructions}
        onAddState={addState}
        onRemoveState={removeState}
        onUpdateStateField={updateStateField}
        onSetInitialState={setInitialState}
        onToggleInstructionsExpanded={toggleInstructionsExpanded}
      />

      {/* ── Transitions table ────────────────────────────────────── */}
      <TransitionsTable
        def={activeDef}
        rules={rules}
        ruleLabelById={ruleLabelById}
        canEdit={canEdit}
        saving={saving}
        highlightedIndex={highlightedTransition}
        onAddTransition={addTransition}
        onRemoveTransition={removeTransition}
        onUpdateTransitionField={updateTransitionField}
        onToggleRule={toggleRule}
      />

      {/* ── Action bar ───────────────────────────────────────────── */}
      {canEdit && (
        <div className="wf-action-bar">
          <Button
            type="button"
            onClick={handleSave}
            disabled={!isDirty || saving || validation.errors.length > 0}
            loading={saving}
          >
            Save changes
          </Button>
          <Button type="button" variant="secondary" onClick={handleCancel} disabled={!isDirty || saving}>
            Cancel
          </Button>
          <div className="wf-action-spacer" />
          <Button
            type="button"
            variant="secondary"
            onClick={() => setConfirmReset(true)}
            disabled={saving || resetting}
          >
            Reset to default
          </Button>
        </div>
      )}

      {/* ── Gate reference ───────────────────────────────────────── */}
      <Card className="wf-gate-ref">
        <h2 className="wf-gate-ref-title">Available gates</h2>
        <p className="wf-gate-ref-desc">
          Built-in precondition rules the backend knows about. Toggle them per transition
          in the table above (admin + custom workflow required).
        </p>
        <ul className="wf-gate-ref-list">
          {rules.map((r) => (
            <li key={r.id} className="wf-gate-ref-item">
              <strong>{r.label}</strong>{" "}
              <code className="wf-gate-id">({r.id})</code>
              <div className="wf-gate-ref-item-desc">{r.description}</div>
            </li>
          ))}
        </ul>
      </Card>

      {/* ── Confirm: Reset to default ────────────────────────────── */}
      <ConfirmDialog
        open={confirmReset}
        title="Reset to default workflow"
        message={
          <>
            <p>Drop the custom workflow and revert this project to the system default?</p>
            {isDirty && <p>Unsaved edits will also be lost.</p>}
          </>
        }
        confirmLabel="Yes, reset"
        cancelLabel="No"
        tone="danger"
        busy={resetting}
        onConfirm={() => void handleReset()}
        onCancel={() => setConfirmReset(false)}
      />

      {/* ── Confirm: Save with warnings ─────────────────────────── */}
      <ConfirmDialog
        open={confirmSaveWarnings}
        title={`Save with ${validation.warnings.length} warning${validation.warnings.length !== 1 ? "s" : ""}`}
        message={
          <>
            <p>The workflow has the following warnings:</p>
            <ul className="wf-gate-ref-list">
              {validation.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
            <p>Save anyway?</p>
          </>
        }
        confirmLabel="Save anyway"
        cancelLabel="Go back"
        busy={saving}
        onConfirm={() => void doSave()}
        onCancel={() => setConfirmSaveWarnings(false)}
      />

      {/* ── Confirm: Apply template over existing custom workflow ── */}
      <ConfirmDialog
        open={confirmTemplateApply !== null}
        title="Apply template over custom workflow"
        message={
          <>
            <p>
              This project already has a custom workflow. Applying a template will
              replace it with the template&apos;s states and transitions.
            </p>
            <p>Any unsaved edits will also be lost. Continue?</p>
          </>
        }
        confirmLabel="Apply template"
        cancelLabel="Cancel"
        tone="danger"
        busy={applyingTemplate}
        onConfirm={() => {
          if (confirmTemplateApply) void doApplyTemplate(confirmTemplateApply);
        }}
        onCancel={() => setConfirmTemplateApply(null)}
      />
    </>
  );
}
