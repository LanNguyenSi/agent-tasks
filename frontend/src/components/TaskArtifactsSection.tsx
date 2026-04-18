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
import { Button } from "./ui/Button";

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
    <section>
      <p className="section-kicker">Artifacts</p>
      {loading && artifacts.length === 0 ? (
        <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>Loading…</p>
      ) : artifacts.length === 0 ? (
        <p style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>
          No artifacts yet. Agents can attach build logs, test reports, and other typed outputs via the API.
        </p>
      ) : (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {grouped.map(([type, items]) => (
            <div key={type}>
              <p
                style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: 600,
                  color: "var(--muted)",
                  marginBottom: "0.3rem",
                  textTransform: "uppercase",
                  letterSpacing: "0.03em",
                }}
              >
                {TYPE_LABELS[type]} ({items.length})
              </p>
              <div style={{ display: "grid", gap: "0.4rem" }}>
                {items.map((a) => {
                  const state = expanded[a.id];
                  // Backend is the source of truth on delete authorization; this
                  // flag only decides whether to render the button. Show it when
                  // the viewer is the human creator or when they can manage all
                  // artifacts in the project (admin). Agent-created artifacts
                  // are never deletable from the web UI — agents use the API.
                  const isHumanCreator =
                    !!a.createdByUserId && a.createdByUserId === user?.id;
                  const canDelete = isHumanCreator || canManageAll;
                  return (
                    <div
                      key={a.id}
                      style={{
                        border: "1px solid var(--border)",
                        borderRadius: "8px",
                        padding: "0.5rem",
                        fontSize: "var(--text-sm)",
                        background: "var(--surface)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: "0.5rem",
                        }}
                      >
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div
                            style={{
                              fontWeight: 600,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {a.name}
                          </div>
                          <div
                            style={{
                              fontSize: "var(--text-xs)",
                              color: "var(--muted)",
                              marginTop: "0.1rem",
                            }}
                          >
                            {creatorLabel(a)} · {new Date(a.createdAt).toLocaleString()}
                            {a.sizeBytes > 0 ? ` · ${formatBytes(a.sizeBytes)}` : ""}
                            {a.mimeType ? ` · ${a.mimeType}` : ""}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: "0.3rem", flexShrink: 0 }}>
                          {a.url ? (
                            <a
                              href={a.url}
                              target="_blank"
                              rel="noreferrer"
                              style={{ fontSize: "var(--text-xs)", alignSelf: "center" }}
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
                            <button
                              type="button"
                              onClick={() => void remove(a)}
                              disabled={deletingId === a.id}
                              style={{
                                background: "none",
                                border: "none",
                                color: "var(--danger)",
                                cursor: "pointer",
                                fontSize: "var(--text-xs)",
                                padding: "0 0.25rem",
                              }}
                            >
                              {deletingId === a.id ? "…" : "Delete"}
                            </button>
                          ) : null}
                        </div>
                      </div>
                      {a.description ? (
                        <p
                          style={{
                            marginTop: "0.3rem",
                            fontSize: "var(--text-xs)",
                            color: "var(--muted)",
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {a.description}
                        </p>
                      ) : null}
                      {state && state !== "loading" ? (
                        <div style={{ marginTop: "0.4rem" }}>
                          <pre
                            style={{
                              margin: 0,
                              padding: "0.5rem",
                              background: "var(--bg)",
                              border: "1px solid var(--border)",
                              borderRadius: "6px",
                              fontSize: "var(--text-xs)",
                              maxHeight: "20rem",
                              overflow: "auto",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                            }}
                          >
                            {state.content ?? "(no inline content)"}
                          </pre>
                          {state.content ? (
                            <div style={{ marginTop: "0.3rem", textAlign: "right" }}>
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
    </section>
  );
}
