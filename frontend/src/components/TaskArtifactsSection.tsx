"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listTaskArtifacts,
  getTaskArtifact,
  deleteTaskArtifact,
  type TaskArtifact,
  type TaskArtifactMeta,
  type TaskArtifactType,
  type User,
} from "../lib/api";
import { isHttpUrl } from "../lib/pr";
import { Button } from "./ui/Button";
import CollapsibleSection from "./ui/CollapsibleSection";
import { Icon } from "./ui/Icon";
import InlineConfirmDelete from "./ui/InlineConfirmDelete";
import { SkeletonList } from "./ui/Skeleton";

const TYPE_LABELS: Record<TaskArtifactType, string> = {
  build_log: "Build logs",
  test_report: "Test reports",
  generated_code: "Generated code",
  coverage: "Coverage",
  diff: "Diffs",
  other: "Other",
};

const TYPE_ORDER: readonly TaskArtifactType[] = [
  "build_log",
  "test_report",
  "coverage",
  "generated_code",
  "diff",
  "other",
];

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function creatorLabel(a: TaskArtifactMeta): string {
  if (a.createdByUser) return a.createdByUser.name ?? a.createdByUser.login;
  if (a.createdByAgent) return `Agent ${a.createdByAgent.name}`;
  return "Unknown";
}

export interface TaskArtifactsSectionProps {
  taskId: string;
  initial?: TaskArtifactMeta[];
  user: User | null;
  /**
   * Whether the current viewer can delete artifacts they did not create
   * (e.g. project admins). When true, the Delete button is always shown;
   * when false, only the creator of the artifact sees it. The backend
   * re-validates in either case, so this purely controls the UX affordance.
   */
  canManageAll?: boolean;
  onError: (message: string) => void;
}

export default function TaskArtifactsSection({
  taskId,
  initial,
  user,
  canManageAll = false,
  onError,
}: TaskArtifactsSectionProps) {
  const [artifacts, setArtifacts] = useState<TaskArtifactMeta[]>(initial ?? []);
  const [loading, setLoading] = useState(initial === undefined);
  const [expanded, setExpanded] = useState<Record<string, TaskArtifact | "loading" | undefined>>({});
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Refetch when the task changes. The task-detail response already ships
  // artifact metadata, but a dedicated fetch keeps the section self-healing
  // after create/delete and ensures fresh data if the modal is reopened.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await listTaskArtifacts(taskId);
      setArtifacts(rows);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [taskId, onError]);

  useEffect(() => {
    if (initial === undefined) void load();
  }, [initial, load]);

  const grouped = useMemo(() => {
    const map = new Map<TaskArtifactType, TaskArtifactMeta[]>();
    for (const a of artifacts) {
      const list = map.get(a.type) ?? [];
      list.push(a);
      map.set(a.type, list);
    }
    return TYPE_ORDER.filter((t) => map.has(t)).map((t) => [t, map.get(t)!] as const);
  }, [artifacts]);

  const togglePreview = async (a: TaskArtifactMeta) => {
    if (expanded[a.id] && expanded[a.id] !== "loading") {
      setExpanded((prev) => ({ ...prev, [a.id]: undefined }));
      return;
    }
    setExpanded((prev) => ({ ...prev, [a.id]: "loading" }));
    try {
      const full = await getTaskArtifact(taskId, a.id);
      setExpanded((prev) => ({ ...prev, [a.id]: full }));
    } catch (err) {
      setExpanded((prev) => ({ ...prev, [a.id]: undefined }));
      onError((err as Error).message);
    }
  };

  const remove = async (a: TaskArtifactMeta) => {
    setDeletingId(a.id);
    try {
      await deleteTaskArtifact(taskId, a.id);
      setArtifacts((prev) => prev.filter((x) => x.id !== a.id));
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[a.id];
        return next;
      });
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setDeletingId(null);
    }
  };

  const download = (full: TaskArtifact) => {
    if (!full.content) return;
    const blob = new Blob([full.content], { type: full.mimeType ?? "text/plain" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = full.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
  };

  return (
    <CollapsibleSection key={taskId} title="Artifacts" count={artifacts.length}>
      {loading && artifacts.length === 0 ? (
        <SkeletonList rows={2} rowHeight="3.5rem" label="Loading artifacts" />
      ) : artifacts.length === 0 ? (
        <div className="ta-empty">
          <Icon name="box" size={15} />
          <span>
            No artifacts yet. Agents publish build logs and reports here via{" "}
            <code className="ta-empty-code">task_artifact_create</code>.
          </span>
        </div>
      ) : (
        <div className="ta-artifact-list">
          {grouped.map(([type, items]) => (
            <div key={type}>
              <p className="ta-type-label">
                {TYPE_LABELS[type]} ({items.length})
              </p>
              <div className="ta-artifact-rows">
                {items.map((a) => {
                  const state = expanded[a.id];
                  // Backend is the source of truth on delete authorization; this
                  // flag only decides whether to render the button. Show it when
                  // the viewer is the human creator or when they can manage all
                  // artifacts in the project (admin). Agent-created artifacts
                  // are never deletable from the web UI — agents use the API.
                  const isHumanCreator = !!a.createdByUserId && a.createdByUserId === user?.id;
                  const canDelete = isHumanCreator || canManageAll;
                  return (
                    <div key={a.id} className="ta-artifact-row">
                      <div className="ta-artifact-row-inner">
                        <div className="ta-artifact-info">
                          <div className="ta-artifact-name">{a.name}</div>
                          <div className="ta-artifact-meta">
                            {creatorLabel(a)} · {new Date(a.createdAt).toLocaleString()}
                            {a.sizeBytes > 0 ? ` · ${formatBytes(a.sizeBytes)}` : ""}
                            {a.mimeType ? ` · ${a.mimeType}` : ""}
                          </div>
                        </div>
                        <div className="ta-artifact-actions">
                          {a.url && isHttpUrl(a.url) ? (
                            <a
                              href={a.url}
                              target="_blank"
                              rel="noreferrer"
                              className="ta-artifact-link"
                            >
                              Open
                            </a>
                          ) : null}
                          {a.sizeBytes > 0 ? (
                            <Button size="sm" onClick={() => void togglePreview(a)}>
                              {state === "loading" ? "…" : state ? "Hide" : "Preview"}
                            </Button>
                          ) : null}
                          {canDelete ? (
                            <InlineConfirmDelete
                              onConfirm={() => void remove(a)}
                              busy={deletingId === a.id}
                            />
                          ) : null}
                        </div>
                      </div>
                      {a.description ? (
                        <p className="ta-artifact-description">{a.description}</p>
                      ) : null}
                      {state && state !== "loading" ? (
                        <div className="ta-artifact-preview">
                          <pre className="ta-artifact-pre text-break-anywhere">
                            {state.content ?? "(no inline content)"}
                          </pre>
                          {state.content ? (
                            <div className="ta-artifact-preview-foot">
                              <Button size="sm" onClick={() => download(state)}>
                                Download
                              </Button>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </CollapsibleSection>
  );
}
