"use client";

// NewTaskFlow: in-place task creation for the cross-project /tasks browser.
// The dashboard's NewTaskModal needs a concrete project (projectId plus that
// project's taskTemplate fields/presets), so this wrapper adds the missing
// step 1: pick a project, fetch its template via getProject, then hand off
// to the unchanged NewTaskModal. With exactly one accessible project the
// picker step is skipped and the form opens directly.

import { useEffect, useState } from "react";
import { getProject, type Project, type Task } from "../../lib/api";
import NewTaskModal from "../dashboard/NewTaskModal";
import AlertBanner from "../ui/AlertBanner";
import { Button } from "../ui/Button";
import EmptyState from "../ui/EmptyState";
import FormField from "../ui/FormField";
import Modal from "../ui/Modal";
import Select from "../ui/Select";

interface NewTaskFlowProps {
  open: boolean;
  onClose: () => void;
  /** Picker options: the team-accessible projects the page already loaded. */
  projects: { id: string; name: string }[];
  /** Called after a task is created so the page can refresh its list. */
  onTaskCreated: (task: Task) => void;
  /** Called when the user clicks "Edit task" in the post-create panel. */
  onEditTask: (taskId: string) => void;
}

export default function NewTaskFlow({
  open,
  onClose,
  projects,
  onTaskCreated,
  onEditTask,
}: NewTaskFlowProps) {
  const [selectedId, setSelectedId] = useState("");
  // Step 2 gate: set once the picked project (with its taskTemplate) loaded.
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadProject(id: string) {
    setLoading(true);
    setError(null);
    try {
      setProject(await getProject(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load project.");
    } finally {
      setLoading(false);
    }
  }

  // Reset per open. Deliberately NOT keyed on `projects`: the page re-fetches
  // on a 30s interval and hands down a fresh array each time; resetting then
  // would wipe an in-progress selection. With a single accessible project,
  // skip the picker and load it immediately.
  useEffect(() => {
    if (!open) return;
    const only = projects.length === 1 ? projects[0]!.id : "";
    setSelectedId(only);
    setProject(null);
    setError(null);
    if (only) void loadProject(only);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  // Step 2: project resolved, hand off to the existing create form.
  if (project) {
    return (
      <NewTaskModal
        open
        onClose={onClose}
        projectId={project.id}
        templateFields={project.taskTemplate?.fields ?? null}
        templatePresets={project.taskTemplate?.presets ?? []}
        onTaskCreated={onTaskCreated}
        onEditTask={onEditTask}
      />
    );
  }

  // Step 1: pick a project (or the empty shell when there is none yet).
  return (
    <Modal
      open
      onClose={onClose}
      title="New Task"
      footer={
        projects.length > 0 ? (
          <Button
            size="sm"
            disabled={!selectedId || loading}
            loading={loading}
            onClick={() => void loadProject(selectedId)}
          >
            Continue
          </Button>
        ) : undefined
      }
    >
      {projects.length === 0 ? (
        <EmptyState
          icon="box"
          title="No projects yet"
          description="Tasks live in a project. Create one from the dashboard first."
          action={
            <Button size="sm" href="/dashboard">
              Go to dashboard
            </Button>
          }
        />
      ) : (
        <>
          {error && (
            <AlertBanner tone="danger" title="Failed to load project" onDismiss={() => setError(null)}>
              {error}
            </AlertBanner>
          )}
          <FormField
            label="Project"
            hint="Step 1 of 2: choose the project the task is created in."
          >
            <Select
              value={selectedId}
              onChange={setSelectedId}
              options={projects.map((p) => ({ value: p.id, label: p.name }))}
              placeholder="Select project…"
            />
          </FormField>
        </>
      )}
    </Modal>
  );
}
