"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getCurrentUser,
  getProject,
  getWorkflows,
  createWorkflow,
  updateWorkflow,
  type User,
  type Project,
  type Workflow,
  type WorkflowDefinition,
  type WorkflowState,
  type WorkflowTransition,
} from "../../../lib/api";
import AppHeader from "../../../components/AppHeader";
import AlertBanner from "../../../components/ui/AlertBanner";
import { Button } from "../../../components/ui/Button";
import Card from "../../../components/ui/Card";
import FormField from "../../../components/ui/FormField";

const DEFAULT_DEFINITION: WorkflowDefinition = {
  initialState: "open",
  states: [
    { name: "open", label: "Open", terminal: false, agentInstructions: "Claim this task, create a branch, then transition to in_progress." },
    { name: "in_progress", label: "In Progress", terminal: false, agentInstructions: "Implement the changes. When done, push the branch, create a PR, update prUrl and branchName, then transition to review." },
    { name: "review", label: "In Review", terminal: false, agentInstructions: "Review is code review only in the default model. Approve or request changes here. Merge, deploy, and production verification are external follow-up actions unless you create explicit workflow states for them." },
    { name: "done", label: "Done", terminal: true },
  ],
  transitions: [
    { from: "open", to: "in_progress" },
    { from: "in_progress", to: "review" },
    { from: "review", to: "in_progress" },
    { from: "review", to: "done" },
  ],
};

export default function WorkflowEditorPage() {
  const router = useRouter();
  const [projectId, setProjectId] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setProjectId(params.get("projectId") ?? "");
  }, []);

  const [user, setUser] = useState<User | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Editable workflow state
  const [workflowName, setWorkflowName] = useState("Standard Agent Workflow");
  const [states, setStates] = useState<WorkflowState[]>(DEFAULT_DEFINITION.states);
  const [transitions, setTransitions] = useState<WorkflowTransition[]>(DEFAULT_DEFINITION.transitions);
  const [initialState, setInitialState] = useState(DEFAULT_DEFINITION.initialState);

  useEffect(() => {
    if (!projectId) return;
    void (async () => {
      const me = await getCurrentUser();
      if (!me) { router.replace("/auth"); return; }
      setUser(me);

      try {
        const proj = await getProject(projectId);
        setProject(proj);

        const workflows = await getWorkflows(projectId);
        const defaultWf = workflows.find((w) => w.isDefault) ?? workflows[0];
        if (defaultWf) {
          setWorkflow(defaultWf);
          setWorkflowName(defaultWf.name);
          setStates(defaultWf.definition.states);
          setTransitions(defaultWf.definition.transitions);
          setInitialState(defaultWf.definition.initialState);
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [projectId, router]);

  function updateState(index: number, patch: Partial<WorkflowState>) {
    setStates((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function removeState(index: number) {
    const stateName = states[index]!.name;
    setStates((prev) => prev.filter((_, i) => i !== index));
    setTransitions((prev) => prev.filter((t) => t.from !== stateName && t.to !== stateName));
  }

  function addState() {
    const name = `state_${Date.now()}`;
    setStates((prev) => [...prev, { name, label: "New State", terminal: false }]);
  }

  function addTransition() {
    if (states.length < 2) return;
    setTransitions((prev) => [...prev, { from: states[0]!.name, to: states[1]!.name }]);
  }

  function updateTransition(index: number, patch: Partial<WorkflowTransition>) {
    setTransitions((prev) => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)));
  }

  function removeTransition(index: number) {
    setTransitions((prev) => prev.filter((_, i) => i !== index));
  }

  function applyDefaultTemplate() {
    setWorkflowName("Standard Agent Workflow");
    setStates(DEFAULT_DEFINITION.states);
    setTransitions(DEFAULT_DEFINITION.transitions);
    setInitialState(DEFAULT_DEFINITION.initialState);
  }

  async function handleSave() {
    if (!projectId) return;
    setSaving(true);
    setError(null);
    setSuccessMsg(null);

    const definition: WorkflowDefinition = { states, transitions, initialState };

    try {
      if (workflow) {
        const updated = await updateWorkflow(workflow.id, {
          name: workflowName,
          definition,
          isDefault: true,
        });
        setWorkflow(updated);
        setSuccessMsg("Workflow updated.");
      } else {
        const created = await createWorkflow(projectId, {
          name: workflowName,
          isDefault: true,
          definition,
        });
        setWorkflow(created);
        setSuccessMsg("Workflow created.");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: "var(--muted)" }}>Loading…</p>
      </main>
    );
  }

  return (
    <main className="page-shell">
      <AppHeader user={user ? { login: user.login, avatarUrl: user.avatarUrl } : null} />

      <Button
        variant="ghost"
        size="sm"
        onClick={() => router.push(projectId ? `/dashboard?projectId=${projectId}` : "/dashboard")}
        style={{ marginBottom: "var(--space-3)" }}
      >
        ← Back to board
      </Button>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-4)", flexWrap: "wrap", gap: "var(--space-2)" }}>
        <div>
          <h1 style={{ fontSize: "var(--text-xl)", fontWeight: 700 }}>Workflow Editor</h1>
          <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>
            {project?.name ?? "Project"} — define states, transitions, and agent instructions
          </p>
        </div>
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
          <Button variant="ghost" size="sm" onClick={applyDefaultTemplate}>Load default template</Button>
          <Button onClick={() => void handleSave()} disabled={saving} loading={saving} size="sm">
            {saving ? "Saving…" : workflow ? "Update Workflow" : "Create Workflow"}
          </Button>
        </div>
      </div>

      {error && <AlertBanner tone="danger" title="Error">{error}</AlertBanner>}
      {successMsg && <AlertBanner tone="success">{successMsg}</AlertBanner>}

      <Card style={{ marginBottom: "var(--space-4)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-3)" }}>
          <FormField label="Workflow Name">
            <input value={workflowName} onChange={(e) => setWorkflowName(e.target.value)} style={{ width: "100%" }} />
          </FormField>
          <FormField label="Initial State">
            <select value={initialState} onChange={(e) => setInitialState(e.target.value)} style={{ width: "100%" }}>
              {states.map((s) => <option key={s.name} value={s.name}>{s.label} ({s.name})</option>)}
            </select>
          </FormField>
        </div>
      </Card>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-2)" }}>
        <h2 style={{ fontSize: "var(--text-base)", fontWeight: 600 }}>States</h2>
        <Button variant="ghost" size="sm" onClick={addState}>+ Add State</Button>
      </div>

      <div style={{ display: "grid", gap: "var(--space-3)", marginBottom: "var(--space-6, 1.5rem)" }}>
        {states.map((state, i) => (
          <Card key={i} padding="sm">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: "var(--space-2)", alignItems: "end", marginBottom: "var(--space-2)" }}>
              <FormField label="Name (key)">
                <input
                  value={state.name}
                  onChange={(e) => {
                    const oldName = state.name;
                    const newName = e.target.value;
                    updateState(i, { name: newName });
                    setTransitions((prev) => prev.map((t) => ({
                      ...t,
                      from: t.from === oldName ? newName : t.from,
                      to: t.to === oldName ? newName : t.to,
                    })));
                    if (initialState === oldName) setInitialState(newName);
                  }}
                  style={{ width: "100%", fontFamily: "monospace", fontSize: "var(--text-xs)" }}
                />
              </FormField>
              <FormField label="Label">
                <input value={state.label} onChange={(e) => updateState(i, { label: e.target.value })} style={{ width: "100%" }} />
              </FormField>
              <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", paddingBottom: "2px" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", fontSize: "var(--text-xs)", color: "var(--muted)", whiteSpace: "nowrap" }}>
                  <input type="checkbox" checked={state.terminal} onChange={(e) => updateState(i, { terminal: e.target.checked })} />
                  Terminal
                </label>
                <Button variant="outline-danger" size="sm" onClick={() => removeState(i)}>Remove</Button>
              </div>
            </div>
            <FormField label="Agent Instructions">
              <textarea
                value={state.agentInstructions ?? ""}
                onChange={(e) => updateState(i, { agentInstructions: e.target.value || undefined })}
                rows={2}
                placeholder="What should the agent do in this state?"
                style={{ width: "100%", resize: "vertical", fontSize: "var(--text-sm)" }}
              />
            </FormField>
          </Card>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-2)" }}>
        <h2 style={{ fontSize: "var(--text-base)", fontWeight: 600 }}>Transitions</h2>
        <Button variant="ghost" size="sm" onClick={addTransition} disabled={states.length < 2}>+ Add Transition</Button>
      </div>

      <div style={{ display: "grid", gap: "var(--space-2)", marginBottom: "var(--space-6, 1.5rem)" }}>
        {transitions.length === 0 && (
          <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>No transitions defined. Add at least one.</p>
        )}
        {transitions.map((t, i) => (
          <Card key={i} padding="sm">
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr auto", gap: "var(--space-2)", alignItems: "end" }}>
              <FormField label="From">
                <select value={t.from} onChange={(e) => updateTransition(i, { from: e.target.value })} style={{ width: "100%" }}>
                  {states.map((s) => <option key={s.name} value={s.name}>{s.label}</option>)}
                </select>
              </FormField>
              <span style={{ color: "var(--muted)", fontSize: "var(--text-base)", paddingBottom: "6px" }}>→</span>
              <FormField label="To">
                <select value={t.to} onChange={(e) => updateTransition(i, { to: e.target.value })} style={{ width: "100%" }}>
                  {states.map((s) => <option key={s.name} value={s.name}>{s.label}</option>)}
                </select>
              </FormField>
              <Button variant="outline-danger" size="sm" onClick={() => removeTransition(i)} style={{ marginBottom: "2px" }}>Remove</Button>
            </div>
          </Card>
        ))}
      </div>

      <Card padding="sm" style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>
        Workflows define valid status transitions and per-state instructions for agents. Tasks assigned to this workflow will have their transitions validated. The <code>GET /api/tasks/:id/instructions</code> endpoint returns the current state&apos;s agentInstructions plus allowed actions. In the default workflow model, <code>review</code> means code review only — merge, deploy, and production verification are external follow-up steps unless you model them as explicit custom workflow states.
      </Card>
    </main>
  );
}
