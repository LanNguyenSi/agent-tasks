"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  getCurrentUser,
  getProject,
  updateProject,
  type User,
  type Project,
  type TaskTemplate,
  type TemplatePreset,
} from "../../../../lib/api";
import AppHeader from "../../../../components/AppHeader";
import AlertBanner from "../../../../components/ui/AlertBanner";
import { Button } from "../../../../components/ui/Button";
import Card from "../../../../components/ui/Card";
import FormField from "../../../../components/ui/FormField";
import {
  NotificationWebhookSection,
  buildWebhookPatch,
} from "../../../../components/NotificationWebhookSection";

// Sensible starting presets offered when a project enables the template but
// has none yet. Moved here from the dashboard along with this form.
const DEFAULT_PRESETS: TemplatePreset[] = [
  {
    name: "Bug Fix",
    description: "[Bug title]: [component/file]\n\nExpected: [what should happen]\nActual: [what happens instead]\nSteps: [how to reproduce]",
    goal: "Fix [describe the bug] in [component/file].\nExpected behavior: [what should happen]\nActual behavior: [what happens instead]",
    acceptanceCriteria: "- Bug is no longer reproducible\n- Root cause is identified and fixed (not just symptoms)\n- Regression test added that covers the exact failure case\n- No unrelated changes",
    context: "- Affected file(s): [path/to/file.ts]\n- How to reproduce: [steps]\n- Related issue/ticket: [link]",
    constraints: "- No breaking changes to public API\n- Keep backwards compatibility\n- Do not refactor surrounding code",
  },
  {
    name: "Feature",
    description: "[Feature name]\n\nWhat: [what should be built]\nWhy: [which problem it solves]\nHow: [rough approach / affected files]",
    goal: "Implement [feature name].\n\n[Describe what the feature does, who it's for, and why it's needed]",
    acceptanceCriteria: "- [Core behavior works as specified]\n- [Edge cases handled: empty state, errors, loading]\n- Tests written (unit + integration where applicable)\n- Types/interfaces updated",
    context: "- Relevant existing code: [path/to/related.ts]\n- Design/spec: [link or description]\n- Dependencies: [libraries, APIs, other features]",
    constraints: "- Follow existing code patterns and conventions\n- No new dependencies without justification\n- Must work with [browser/runtime requirements]",
  },
  {
    name: "Refactoring",
    description: "Refactor [module/component]\n\nMotivation: [why now]\nGoal: [what improves: readability, performance, testability]",
    goal: "Refactor [component/module] to [improve what exactly].\n\nMotivation: [why this refactoring is needed now]",
    acceptanceCriteria: "- All existing tests still pass\n- No behavior changes (pure refactor)\n- Code is measurably [simpler/faster/more readable]\n- No new tech debt introduced",
    context: "- Files to touch: [list of files]\n- Current pain points: [what makes the current code problematic]\n- Related refactoring: [other planned changes that depend on this]",
    constraints: "- Pure refactor, zero behavior changes\n- Keep the PR focused, no scope creep\n- If a file isn't broken, don't touch it",
  },
];

type GovernanceMode =
  | "REQUIRES_DISTINCT_REVIEWER"
  | "AWAITS_CONFIRMATION"
  | "AUTONOMOUS";

/**
 * Agent Template & governance settings for a single project, mounted at
 * /projects/[id]/settings. This was previously a modal on the dashboard;
 * with the template enabled it grew tall enough that a dedicated page reads
 * better. Reached from the gear icon on the board. Mirrors the page pattern
 * used by /projects/[id]/members (page-shell + AppHeader + back link).
 */
export default function ProjectSettingsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const router = useRouter();

  const [user, setUser] = useState<User | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const [settingsTemplateEnabled, setSettingsTemplateEnabled] = useState(false);
  const [settingsThreshold, setSettingsThreshold] = useState(60);
  const [settingsFieldGoal, setSettingsFieldGoal] = useState(true);
  const [settingsFieldAC, setSettingsFieldAC] = useState(true);
  const [settingsFieldContext, setSettingsFieldContext] = useState(true);
  const [settingsFieldConstraints, setSettingsFieldConstraints] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsPresets, setSettingsPresets] = useState<TemplatePreset[]>([]);
  const [settingsGovernanceMode, setSettingsGovernanceMode] =
    useState<GovernanceMode>("AWAITS_CONFIRMATION");
  // `settingsWebhookSecret === null` means the operator did not touch the
  // secret in this session, so it is omitted from the PATCH and the stored
  // value is preserved. Empty string means "clear it".
  const [settingsWebhookUrl, setSettingsWebhookUrl] = useState("");
  const [settingsWebhookHasSecret, setSettingsWebhookHasSecret] = useState(false);
  const [settingsWebhookSecret, setSettingsWebhookSecret] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await getCurrentUser();
        if (!me) {
          router.replace("/auth");
          return;
        }
        // Set the user before the project fetch so the header stays
        // authenticated even if getProject fails (bad/unauthorized id).
        if (cancelled) return;
        setUser(me);
        const proj = await getProject(projectId);
        if (cancelled) return;
        setProject(proj);
        const tpl = proj.taskTemplate;
        setSettingsTemplateEnabled(!!tpl);
        setSettingsThreshold(proj.confidenceThreshold ?? 60);
        setSettingsFieldGoal(tpl?.fields?.goal ?? true);
        setSettingsFieldAC(tpl?.fields?.acceptanceCriteria ?? true);
        setSettingsFieldContext(tpl?.fields?.context ?? true);
        setSettingsFieldConstraints(tpl?.fields?.constraints ?? true);
        setSettingsPresets(
          tpl?.presets?.length
            ? tpl.presets.map((p) => ({ ...p }))
            : DEFAULT_PRESETS.map((p) => ({ ...p })),
        );
        setSettingsGovernanceMode(
          proj.governanceMode ??
            (proj.soloMode
              ? "AUTONOMOUS"
              : proj.requireDistinctReviewer
                ? "REQUIRES_DISTINCT_REVIEWER"
                : "AWAITS_CONFIRMATION"),
        );
        setSettingsWebhookUrl(proj.notificationWebhookUrl ?? "");
        setSettingsWebhookHasSecret(!!proj.hasNotificationWebhookSecret);
        setSettingsWebhookSecret(null);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, router]);

  const boardHref = project
    ? `/dashboard?teamId=${project.teamId}&projectId=${projectId}`
    : "/dashboard";

  async function handleSave() {
    setSavingSettings(true);
    setError(null);
    setSavedMessage(null);
    try {
      const validPresets = settingsPresets.filter((p) => p.name.trim());
      const tpl: TaskTemplate | null = settingsTemplateEnabled
        ? {
            fields: {
              goal: settingsFieldGoal,
              acceptanceCriteria: settingsFieldAC,
              context: settingsFieldContext,
              constraints: settingsFieldConstraints,
            },
            presets: validPresets,
          }
        : null;
      const webhookPatch = buildWebhookPatch({
        initialWebhookUrl: project?.notificationWebhookUrl ?? null,
        urlDraft: settingsWebhookUrl,
        secretDraft: settingsWebhookSecret,
      });
      const updated = await updateProject(projectId, {
        taskTemplate: tpl,
        confidenceThreshold: settingsThreshold,
        governanceMode: settingsGovernanceMode,
        ...webhookPatch,
      });
      setProject(updated);
      // Re-sync the webhook draft to the saved state so a subsequent save
      // doesn't re-send or clear the secret unintentionally.
      setSettingsWebhookHasSecret(!!updated.hasNotificationWebhookSecret);
      setSettingsWebhookSecret(null);
      setSavedMessage("Settings saved.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingSettings(false);
    }
  }

  return (
    <main className="page-shell">
      <AppHeader
        user={user ? { login: user.login, avatarUrl: user.avatarUrl } : null}
        boardHref={boardHref}
      />

      <p style={{ fontSize: "var(--text-sm)", marginBottom: "var(--space-3)" }}>
        <Link href={boardHref} style={{ color: "var(--muted)" }}>
          ← Back to board
        </Link>
      </p>

      <h1 style={{ marginBottom: "var(--space-2)" }}>Agent Template Settings</h1>
      {project && (
        <p style={{ color: "var(--muted)", marginBottom: "var(--space-5)" }}>
          {project.name} ({project.slug})
        </p>
      )}

      {error && (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <AlertBanner tone="danger">{error}</AlertBanner>
        </div>
      )}
      {savedMessage && (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <AlertBanner tone="success">{savedMessage}</AlertBanner>
        </div>
      )}

      {loading && <p style={{ color: "var(--muted)" }}>Loading…</p>}

      {!loading && project && (
        <Card style={{ maxWidth: 760 }}>
          <div style={{ marginBottom: "0.75rem" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "var(--text-sm)", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={settingsTemplateEnabled}
                onChange={(e) => setSettingsTemplateEnabled(e.target.checked)}
              />
              Enable task template for this project
            </label>
          </div>

          <div style={{ marginBottom: "0.75rem", paddingBottom: "0.75rem", borderBottom: "1px solid var(--border)" }}>
            <p style={{ fontSize: "var(--text-sm)", fontWeight: 600, marginBottom: "0.4rem" }}>Governance mode</p>
            <div style={{ display: "grid", gap: "0.5rem" }}>
              {([
                [
                  "REQUIRES_DISTINCT_REVIEWER",
                  "Requires distinct reviewer",
                  <>Dual-control. <code>review → done</code> requires a different user or agent than the task&apos;s claimant to hold the review lock (via <code>POST /tasks/:id/review/claim</code>). Self-merge attempts are blocked upstream. Team admins can still bypass with a forced transition.</>,
                ],
                [
                  "AWAITS_CONFIRMATION",
                  "Awaits human confirmation",
                  <>Agent may self-merge, but every human on the team receives a <code>self_merge_notice</code> signal when the task reaches <code>done</code>. Gives visibility without blocking the flow. Use this when you trust the agent day-to-day but want a record you can audit asynchronously.</>,
                ],
                [
                  "AUTONOMOUS",
                  "Autonomous",
                  <>Single-actor workflow. No gates, no notifications. Merge still moves the task straight to <code>done</code> via the webhook. Branch protection rules on GitHub remain the primary safeguard &mdash; do not enable without <code>require_pull_request_reviews</code> and at least one required status check.</>,
                ],
              ] as const).map(([value, label, description]) => (
                <label
                  key={value}
                  style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", fontSize: "var(--text-sm)", cursor: "pointer" }}
                >
                  <input
                    type="radio"
                    name="governanceMode"
                    value={value}
                    checked={settingsGovernanceMode === value}
                    onChange={() => setSettingsGovernanceMode(value)}
                    style={{ marginTop: "0.2rem" }}
                  />
                  <span>
                    {label}
                    <span style={{ display: "block", color: "var(--muted)", fontSize: "var(--text-xs)", marginTop: "0.15rem" }}>
                      {description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <NotificationWebhookSection
            initialWebhookUrl={project.notificationWebhookUrl ?? null}
            hasSecret={settingsWebhookHasSecret}
            urlDraft={settingsWebhookUrl}
            onUrlDraftChange={setSettingsWebhookUrl}
            secretDraft={settingsWebhookSecret}
            onSecretDraftChange={setSettingsWebhookSecret}
          />

          {settingsTemplateEnabled && (
            <>
              <div style={{ marginBottom: "0.75rem" }}>
                <p style={{ fontSize: "var(--text-sm)", fontWeight: 600, marginBottom: "0.4rem" }}>Template Fields</p>
                <div style={{ display: "grid", gap: "0.3rem" }}>
                  {([
                    ["goal", "Goal", settingsFieldGoal, setSettingsFieldGoal],
                    ["acceptanceCriteria", "Acceptance Criteria", settingsFieldAC, setSettingsFieldAC],
                    ["context", "Context", settingsFieldContext, setSettingsFieldContext],
                    ["constraints", "Constraints", settingsFieldConstraints, setSettingsFieldConstraints],
                  ] as [string, string, boolean, (v: boolean) => void][]).map(([, label, checked, setter]) => (
                    <label key={label} style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "var(--text-sm)", cursor: "pointer" }}>
                      <input type="checkbox" checked={checked} onChange={(e) => setter(e.target.checked)} />
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              <div style={{ marginBottom: "0.75rem" }}>
                <FormField label={`Confidence Threshold: ${settingsThreshold}`}>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={settingsThreshold}
                    onChange={(e) => setSettingsThreshold(Number(e.target.value))}
                    style={{ width: "100%" }}
                  />
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--text-xs)", color: "var(--muted)" }}>
                    <span>0 (no gate)</span>
                    <span>100 (all fields required)</span>
                  </div>
                </FormField>
              </div>

              <div style={{ marginBottom: "0.75rem" }}>
                <p style={{ fontSize: "var(--text-sm)", fontWeight: 600, marginBottom: "0.4rem" }}>Presets</p>
                <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "0.4rem" }}>
                  Reusable starting points that pre-fill template fields when creating a task.
                </p>
                {settingsPresets.map((preset, idx) => (
                  <div key={idx} style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.5rem", marginBottom: "0.4rem", background: "var(--surface)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.4rem" }}>
                      <input
                        value={preset.name}
                        onChange={(e) => {
                          const next = [...settingsPresets];
                          next[idx] = { ...next[idx], name: e.target.value };
                          setSettingsPresets(next);
                        }}
                        placeholder="Preset name"
                        style={{ fontWeight: 600, fontSize: "var(--text-sm)", flex: 1 }}
                      />
                      <button
                        type="button"
                        onClick={() => setSettingsPresets(settingsPresets.filter((_, i) => i !== idx))}
                        style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", fontSize: "var(--text-sm)", padding: "0 0.3rem" }}
                      >
                        Remove
                      </button>
                    </div>
                    <div style={{ display: "grid", gap: "0.3rem" }}>
                      <textarea
                        value={preset.description ?? ""}
                        onChange={(e) => { const next = [...settingsPresets]; next[idx] = { ...next[idx], description: e.target.value }; setSettingsPresets(next); }}
                        placeholder="Description"
                        rows={2}
                        style={{ width: "100%", resize: "vertical", fontSize: "var(--text-xs)" }}
                      />
                      {settingsFieldGoal && (
                        <textarea
                          value={preset.goal ?? ""}
                          onChange={(e) => { const next = [...settingsPresets]; next[idx] = { ...next[idx], goal: e.target.value }; setSettingsPresets(next); }}
                          placeholder="Goal"
                          rows={1}
                          style={{ width: "100%", resize: "vertical", fontSize: "var(--text-xs)" }}
                        />
                      )}
                      {settingsFieldAC && (
                        <textarea
                          value={preset.acceptanceCriteria ?? ""}
                          onChange={(e) => { const next = [...settingsPresets]; next[idx] = { ...next[idx], acceptanceCriteria: e.target.value }; setSettingsPresets(next); }}
                          placeholder="Acceptance Criteria"
                          rows={1}
                          style={{ width: "100%", resize: "vertical", fontSize: "var(--text-xs)" }}
                        />
                      )}
                      {settingsFieldContext && (
                        <textarea
                          value={preset.context ?? ""}
                          onChange={(e) => { const next = [...settingsPresets]; next[idx] = { ...next[idx], context: e.target.value }; setSettingsPresets(next); }}
                          placeholder="Context"
                          rows={1}
                          style={{ width: "100%", resize: "vertical", fontSize: "var(--text-xs)" }}
                        />
                      )}
                      {settingsFieldConstraints && (
                        <textarea
                          value={preset.constraints ?? ""}
                          onChange={(e) => { const next = [...settingsPresets]; next[idx] = { ...next[idx], constraints: e.target.value }; setSettingsPresets(next); }}
                          placeholder="Constraints"
                          rows={1}
                          style={{ width: "100%", resize: "vertical", fontSize: "var(--text-xs)" }}
                        />
                      )}
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  className="filter-chip"
                  onClick={() => setSettingsPresets([...settingsPresets, { name: "" }])}
                  style={{ marginTop: "0.2rem" }}
                >
                  + Add preset
                </button>
              </div>
            </>
          )}

          <div style={{ marginTop: "var(--space-4)", display: "flex", gap: "0.5rem" }}>
            <Button
              disabled={savingSettings}
              loading={savingSettings}
              onClick={() => void handleSave()}
            >
              {savingSettings ? "Saving…" : "Save settings"}
            </Button>
            <Button variant="ghost" onClick={() => router.push(boardHref)} disabled={savingSettings}>
              Back to board
            </Button>
          </div>
        </Card>
      )}
    </main>
  );
}
