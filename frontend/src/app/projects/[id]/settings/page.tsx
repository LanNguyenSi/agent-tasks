"use client";

// Project settings page: /projects/[id]/settings.
// Split into three sectioned cards: Governance, Notifications, Task template.
// The hub layout (layout.tsx) renders the project name H1 and subnav; this
// page renders the settings content only.

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  getCurrentUser,
  getProject,
  updateProject,
  type User,
  type Project,
  type TaskTemplate,
  type TemplatePreset,
} from "../../../../lib/api";
import AlertBanner from "../../../../components/ui/AlertBanner";
import { Button } from "../../../../components/ui/Button";
import Card from "../../../../components/ui/Card";
import FormField from "../../../../components/ui/FormField";
import { Skeleton } from "../../../../components/ui/Skeleton";
import {
  NotificationWebhookSection,
  buildWebhookPatch,
} from "../../../../components/NotificationWebhookSection";
import GovernanceModeField, {
  type GovernanceMode,
} from "../../../../components/projects/GovernanceModeField";
import PresetEditor from "../../../../components/projects/PresetEditor";

// Sensible starting presets offered when a project enables the template but
// has none yet. Moved here from the dashboard along with this form.
const DEFAULT_PRESETS: TemplatePreset[] = [
  {
    name: "Bug Fix",
    description:
      "[Bug title]: [component/file]\n\nExpected: [what should happen]\nActual: [what happens instead]\nSteps: [how to reproduce]",
    goal: "Fix [describe the bug] in [component/file].\nExpected behavior: [what should happen]\nActual behavior: [what happens instead]",
    acceptanceCriteria:
      "- Bug is no longer reproducible\n- Root cause is identified and fixed (not just symptoms)\n- Regression test added that covers the exact failure case\n- No unrelated changes",
    context:
      "- Affected file(s): [path/to/file.ts]\n- How to reproduce: [steps]\n- Related issue/ticket: [link]",
    constraints:
      "- No breaking changes to public API\n- Keep backwards compatibility\n- Do not refactor surrounding code",
  },
  {
    name: "Feature",
    description:
      "[Feature name]\n\nWhat: [what should be built]\nWhy: [which problem it solves]\nHow: [rough approach / affected files]",
    goal: "Implement [feature name].\n\n[Describe what the feature does, who it's for, and why it's needed]",
    acceptanceCriteria:
      "- [Core behavior works as specified]\n- [Edge cases handled: empty state, errors, loading]\n- Tests written (unit + integration where applicable)\n- Types/interfaces updated",
    context:
      "- Relevant existing code: [path/to/related.ts]\n- Design/spec: [link or description]\n- Dependencies: [libraries, APIs, other features]",
    constraints:
      "- Follow existing code patterns and conventions\n- No new dependencies without justification\n- Must work with [browser/runtime requirements]",
  },
  {
    name: "Refactoring",
    description:
      "Refactor [module/component]\n\nMotivation: [why now]\nGoal: [what improves: readability, performance, testability]",
    goal: "Refactor [component/module] to [improve what exactly].\n\nMotivation: [why this refactoring is needed now]",
    acceptanceCriteria:
      "- All existing tests still pass\n- No behavior changes (pure refactor)\n- Code is measurably [simpler/faster/more readable]\n- No new tech debt introduced",
    context:
      "- Files to touch: [list of files]\n- Current pain points: [what makes the current code problematic]\n- Related refactoring: [other planned changes that depend on this]",
    constraints:
      "- Pure refactor, zero behavior changes\n- Keep the PR focused, no scope creep\n- If a file isn't broken, don't touch it",
  },
];

export default function ProjectSettingsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const router = useRouter();

  const [, setUser] = useState<User | null>(null);
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
  const [settingsWebhookUrl, setSettingsWebhookUrl] = useState("");
  const [settingsWebhookHasSecret, setSettingsWebhookHasSecret] =
    useState(false);
  const [settingsWebhookSecret, setSettingsWebhookSecret] = useState<
    string | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await getCurrentUser();
        if (!me) {
          router.replace("/auth");
          return;
        }
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
      setSettingsWebhookHasSecret(!!updated.hasNotificationWebhookSecret);
      setSettingsWebhookSecret(null);
      setSavedMessage("Settings saved.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingSettings(false);
    }
  }

  if (loading) {
    return (
      <div
        role="status"
        aria-busy="true"
        // eslint-disable-next-line no-restricted-syntax
        style={{ maxWidth: 760 }} /* dynamic: max-width constraint */
      >
        <span className="sr-only">Loading settings</span>
        {/* eslint-disable-next-line no-restricted-syntax */}
        <Skeleton height="12rem" radius="var(--radius-lg)" style={{ marginBottom: "var(--space-4)" }} /* dynamic: spacing between skeleton blocks */ />
        {/* eslint-disable-next-line no-restricted-syntax */}
        <Skeleton height="8rem" radius="var(--radius-lg)" style={{ marginBottom: "var(--space-4)" }} /* dynamic: spacing between skeleton blocks */ />
        <Skeleton height="6rem" radius="var(--radius-lg)" />
      </div>
    );
  }

  return (
    // eslint-disable-next-line no-restricted-syntax
    <div style={{ maxWidth: 760 }}> {/* dynamic: max-width constraint */}
      {error && (
        <div
          // eslint-disable-next-line no-restricted-syntax
          style={{ marginBottom: "var(--space-4)" }} /* dynamic: spacing */
        >
          <AlertBanner tone="danger">{error}</AlertBanner>
        </div>
      )}
      {savedMessage && (
        <div
          // eslint-disable-next-line no-restricted-syntax
          style={{ marginBottom: "var(--space-4)" }} /* dynamic: spacing */
        >
          <AlertBanner tone="success">{savedMessage}</AlertBanner>
        </div>
      )}

      {project && (
        <>
          {/* ── Governance ─────────────────────────────────────────── */}
          <Card
            surface="raised"
            // eslint-disable-next-line no-restricted-syntax
            style={{ marginBottom: "var(--space-4)" }} /* dynamic: spacing */
          >
            <div className="proj-card-section">
              <p className="proj-section-head">Governance</p>
              <p className="proj-section-desc">
                Controls how tasks can be reviewed and merged. Changing this
                affects all new and in-flight tasks in this project.
              </p>
              <GovernanceModeField
                value={settingsGovernanceMode}
                onChange={setSettingsGovernanceMode}
              />
            </div>
          </Card>

          {/* ── Notifications ──────────────────────────────────────── */}
          <Card
            surface="raised"
            // eslint-disable-next-line no-restricted-syntax
            style={{ marginBottom: "var(--space-4)" }} /* dynamic: spacing */
          >
            <div className="proj-card-section">
              <p className="proj-section-head">Notifications</p>
              <p className="proj-section-desc">
                Optional webhook that receives Signal push-delivery payloads
                for task state changes. See{" "}
                <a
                  href="https://github.com/LanNguyenSi/agent-tasks/blob/master/docs/notification-webhooks.md"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  docs/notification-webhooks.md
                </a>{" "}
                for the payload schema.
              </p>
              <NotificationWebhookSection
                initialWebhookUrl={project.notificationWebhookUrl ?? null}
                hasSecret={settingsWebhookHasSecret}
                urlDraft={settingsWebhookUrl}
                onUrlDraftChange={setSettingsWebhookUrl}
                secretDraft={settingsWebhookSecret}
                onSecretDraftChange={setSettingsWebhookSecret}
              />
            </div>
          </Card>

          {/* ── Task template ──────────────────────────────────────── */}
          <Card
            surface="raised"
            // eslint-disable-next-line no-restricted-syntax
            style={{ marginBottom: "var(--space-4)" }} /* dynamic: spacing */
          >
            <div className="proj-card-section">
              <p className="proj-section-head">Task template</p>
              <p className="proj-section-desc">
                Structured fields and preset starting points shown to agents
                and humans when creating tasks.
              </p>
              <label
                // eslint-disable-next-line no-restricted-syntax
                style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--text-sm)", cursor: "pointer", marginBottom: "var(--space-3)" }} /* dynamic: inline row */
              >
                <input
                  type="checkbox"
                  checked={settingsTemplateEnabled}
                  onChange={(e) =>
                    setSettingsTemplateEnabled(e.target.checked)
                  }
                />
                Enable task template for this project
              </label>

              {settingsTemplateEnabled && (
                <>
                  <div
                    // eslint-disable-next-line no-restricted-syntax
                    style={{ marginBottom: "var(--space-3)" }} /* dynamic: spacing */
                  >
                    <p
                      // eslint-disable-next-line no-restricted-syntax
                      style={{ fontSize: "var(--text-sm)", fontWeight: 600, marginBottom: "var(--space-2)" }} /* dynamic: heading weight */
                    >
                      Template fields
                    </p>
                    <div
                      // eslint-disable-next-line no-restricted-syntax
                      style={{ display: "grid", gap: "var(--space-2)" }} /* dynamic: grid gap */
                    >
                      {(
                        [
                          [
                            "goal",
                            "Goal",
                            settingsFieldGoal,
                            setSettingsFieldGoal,
                          ],
                          [
                            "acceptanceCriteria",
                            "Acceptance criteria",
                            settingsFieldAC,
                            setSettingsFieldAC,
                          ],
                          [
                            "context",
                            "Context",
                            settingsFieldContext,
                            setSettingsFieldContext,
                          ],
                          [
                            "constraints",
                            "Constraints",
                            settingsFieldConstraints,
                            setSettingsFieldConstraints,
                          ],
                        ] as [
                          string,
                          string,
                          boolean,
                          (v: boolean) => void,
                        ][]
                      ).map(([, label, checked, setter]) => (
                        <label
                          key={label}
                          // eslint-disable-next-line no-restricted-syntax
                          style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--text-sm)", cursor: "pointer" }} /* dynamic: inline row */
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => setter(e.target.checked)}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </div>

                  <div
                    // eslint-disable-next-line no-restricted-syntax
                    style={{ marginBottom: "var(--space-3)" }} /* dynamic: spacing */
                  >
                    <FormField
                      label={`Confidence threshold: ${settingsThreshold}`}
                    >
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={settingsThreshold}
                        onChange={(e) =>
                          setSettingsThreshold(Number(e.target.value))
                        }
                        // eslint-disable-next-line no-restricted-syntax
                        style={{ width: "100%" }} /* dynamic: full-width range */
                      />
                    </FormField>
                    <div
                      // eslint-disable-next-line no-restricted-syntax
                      style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--text-xs)", color: "var(--muted)", marginTop: "var(--space-1)" }} /* dynamic: row layout */
                    >
                      <span>0 (no gate)</span>
                      <span>100 (all fields required)</span>
                    </div>
                  </div>

                  <p
                    // eslint-disable-next-line no-restricted-syntax
                    style={{ fontSize: "var(--text-sm)", fontWeight: 600, marginBottom: "var(--space-2)" }} /* dynamic: heading weight */
                  >
                    Presets
                  </p>
                  <PresetEditor
                    presets={settingsPresets}
                    onChange={setSettingsPresets}
                    showGoal={settingsFieldGoal}
                    showAC={settingsFieldAC}
                    showContext={settingsFieldContext}
                    showConstraints={settingsFieldConstraints}
                  />
                </>
              )}
            </div>
          </Card>

          <div
            // eslint-disable-next-line no-restricted-syntax
            style={{ display: "flex", gap: "var(--space-2)" }} /* dynamic: button row */
          >
            <Button
              disabled={savingSettings}
              loading={savingSettings}
              onClick={() => void handleSave()}
            >
              {savingSettings ? "Saving…" : "Save settings"}
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                router.push(
                  `/dashboard?teamId=${project.teamId}&projectId=${projectId}`,
                )
              }
              disabled={savingSettings}
            >
              Back to board
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
