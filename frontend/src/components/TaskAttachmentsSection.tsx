"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  uploadTaskAttachmentFile,
  deleteTaskAttachment,
  rawAttachmentUrl,
  type TaskAttachment,
  type User,
} from "../lib/api";
import { Button } from "./ui/Button";
import CollapsibleSection from "./ui/CollapsibleSection";
import { Icon } from "./ui/Icon";
import InlineConfirmDelete from "./ui/InlineConfirmDelete";

// Mirrors the backend cap and allowlist. The client check is a friendly
// pre-flight only; the backend re-validates by magic-byte sniff.
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/markdown",
  "text/csv",
]);
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".txt", ".md", ".markdown", ".csv"]);

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fileExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

/** Returns an error message if the file is not uploadable, else null. */
export function validateAttachmentFile(file: { name: string; type: string; size: number }): string | null {
  if (file.size === 0) return `"${file.name}" is empty.`;
  if (file.size > MAX_ATTACHMENT_BYTES) return `"${file.name}" exceeds the 5 MiB limit.`;
  if (ALLOWED_MIME.has(file.type) || ALLOWED_EXT.has(fileExt(file.name))) return null;
  return `"${file.name}" is not an allowed type. Allowed: images (jpeg, png, gif, webp) and text (plain, markdown, csv).`;
}

function creatorLabel(a: TaskAttachment): string {
  if (a.createdByUser) return a.createdByUser.name ?? a.createdByUser.login;
  return "Unknown";
}

export interface TaskAttachmentsSectionProps {
  taskId: string;
  initial?: TaskAttachment[];
  user: User | null;
  /**
   * Whether the viewer may delete attachments they did not upload (project
   * admins). The backend re-validates either way; this only controls the
   * affordance. Defaults to false (only the uploader sees Delete).
   */
  canManageAll?: boolean;
  onError: (message: string) => void;
}

export default function TaskAttachmentsSection({
  taskId,
  initial,
  user,
  canManageAll = false,
  onError,
}: TaskAttachmentsSectionProps) {
  const [items, setItems] = useState<TaskAttachment[]>(initial ?? []);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [preview, setPreview] = useState<TaskAttachment | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastTaskId = useRef(taskId);
  const dialogRef = useRef<HTMLDivElement>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);

  // Re-seed when the parent reuses this component for a different task (the
  // board modal swaps tasks without unmounting). There is no list endpoint, so
  // within a task the state is maintained optimistically on upload/delete.
  useEffect(() => {
    if (lastTaskId.current !== taskId) {
      lastTaskId.current = taskId;
      setItems(initial ?? []);
    }
  }, [taskId, initial]);

  // Lightbox: close on Escape, move focus into the dialog on open, and restore
  // focus to the previously focused element (the thumbnail) on close.
  useEffect(() => {
    if (!preview) return;
    lastFocusRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreview(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      lastFocusRef.current?.focus?.();
    };
  }, [preview]);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files);
      if (arr.length === 0) return;
      setUploading(true);
      try {
        for (const file of arr) {
          const reason = validateAttachmentFile(file);
          if (reason) {
            onError(reason);
            continue;
          }
          try {
            const created = await uploadTaskAttachmentFile(taskId, file);
            setItems((prev) => [created, ...prev]);
          } catch (err) {
            onError((err as Error).message);
          }
        }
      } finally {
        setUploading(false);
      }
    },
    [taskId, onError],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (uploading) return;
      if (e.dataTransfer.files.length > 0) void handleFiles(e.dataTransfer.files);
    },
    [handleFiles, uploading],
  );

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) void handleFiles(e.target.files);
      e.target.value = ""; // allow re-selecting the same file
    },
    [handleFiles],
  );

  const remove = useCallback(
    async (a: TaskAttachment) => {
      setDeletingId(a.id);
      try {
        await deleteTaskAttachment(taskId, a.id);
        setItems((prev) => prev.filter((x) => x.id !== a.id));
        setPreview((p) => (p?.id === a.id ? null : p));
      } catch (err) {
        onError((err as Error).message);
      } finally {
        setDeletingId(null);
      }
    },
    [taskId, onError],
  );

  const images = useMemo(() => items.filter((a) => a.type === "IMAGE"), [items]);
  const docs = useMemo(() => items.filter((a) => a.type !== "IMAGE"), [items]);

  const canDelete = (a: TaskAttachment): boolean =>
    canManageAll || (!!a.createdByUserId && a.createdByUserId === user?.id);

  const hiddenInput = (
    <input
      ref={inputRef}
      type="file"
      accept="image/jpeg,image/png,image/gif,image/webp,text/plain,text/markdown,text/csv,.md,.markdown,.csv,.txt"
      multiple
      disabled={uploading}
      className="sr-only"
      onChange={onInputChange}
    />
  );

  return (
    <CollapsibleSection key={taskId} title="Attachments" count={items.length}>
      <div className="tas-root">
        {items.length === 0 ? (
          /* Designed empty state — the entire box is also the drop zone */
          <div
            className={["tas-empty", dragOver ? "tas-empty--drag-over" : ""].filter(Boolean).join(" ")}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
            aria-label="Upload an attachment"
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
          >
            <Icon name="clip" size={15} />
            <span className="tas-empty-text">
              {uploading
                ? "Uploading…"
                : "No attachments yet. Drag a file here, or paste an image into a comment."}
            </span>
            {!uploading && (
              <Button size="sm" variant="ghost" onClick={(e: React.MouseEvent) => { e.stopPropagation(); inputRef.current?.click(); }}>
                <Icon name="clip" size={13} />
                Attach file
              </Button>
            )}
            {hiddenInput}
          </div>
        ) : (
          <>
            {/* Compact upload zone when items already exist */}
            <div
              className={["tas-upload-zone", dragOver ? "tas-upload-zone--drag-over" : ""].filter(Boolean).join(" ")}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              role="button"
              tabIndex={0}
              aria-label="Upload an attachment"
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  inputRef.current?.click();
                }
              }}
            >
              <p className="tas-upload-title">
                {uploading ? "Uploading…" : "Drop an image or text file here"}
              </p>
              <p className="tas-upload-hint">
                or click to browse · images (jpeg, png, gif, webp) and text (plain, markdown, csv), up to 5 MiB
              </p>
              {hiddenInput}
            </div>

            {/* Image thumbnails */}
            {images.length > 0 && (
              <div className="tas-image-grid">
                {images.map((a) => (
                  <div key={a.id} className="tas-thumb-cell">
                    <button
                      type="button"
                      onClick={() => setPreview(a)}
                      aria-label={`Preview ${a.name}`}
                      className="tas-thumb-btn"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- auth-gated raw endpoint, not a static asset for next/image */}
                      <img
                        src={rawAttachmentUrl(taskId, a.id)}
                        alt={a.name}
                        className="tas-thumb-img"
                      />
                    </button>
                    <div className="tas-thumb-name" title={a.name}>{a.name}</div>
                    {canDelete(a) && (
                      <InlineConfirmDelete
                        onConfirm={() => void remove(a)}
                        busy={deletingId === a.id}
                        ariaLabel={`Delete ${a.name}`}
                        confirmAriaLabel={`Confirm delete ${a.name}`}
                        cancelAriaLabel={`Cancel delete ${a.name}`}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Text / document rows */}
            {docs.length > 0 && (
              <div className="tas-doc-list">
                {docs.map((a) => (
                  <div key={a.id} className="tas-doc-row">
                    <div className="tas-doc-info">
                      <div className="tas-doc-name">{a.name}</div>
                      <div className="tas-doc-meta">
                        {creatorLabel(a)} · {new Date(a.createdAt).toLocaleString()}
                        {a.sizeBytes > 0 ? ` · ${formatBytes(a.sizeBytes)}` : ""}
                        {a.mimeType ? ` · ${a.mimeType}` : ""}
                      </div>
                    </div>
                    <div className="tas-doc-actions">
                      <a
                        href={rawAttachmentUrl(taskId, a.id)}
                        download={a.name}
                        className="tas-doc-download"
                      >
                        Download
                      </a>
                      {canDelete(a) && (
                        <InlineConfirmDelete
                          onConfirm={() => void remove(a)}
                          busy={deletingId === a.id}
                          ariaLabel={`Delete ${a.name}`}
                          confirmAriaLabel={`Confirm delete ${a.name}`}
                          cancelAriaLabel={`Cancel delete ${a.name}`}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* Lightbox */}
        {preview && (
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={`Preview of ${preview.name}`}
            tabIndex={-1}
            onClick={() => setPreview(null)}
            className="tas-lightbox"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- auth-gated raw endpoint */}
            <img
              src={rawAttachmentUrl(taskId, preview.id)}
              alt={preview.name}
              className="tas-lightbox-img"
            />
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}
