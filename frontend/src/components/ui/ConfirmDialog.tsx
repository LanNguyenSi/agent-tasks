"use client";

import { Button } from "./Button";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  tone?: "default" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  busy = false,
  tone = "default",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card confirm-modal-card" onClick={(event) => event.stopPropagation()}>
        <h3 style={{ fontSize: "var(--text-md, 1rem)", fontWeight: 700, marginBottom: "var(--space-2, 0.5rem)" }}>{title}</h3>
        <p style={{ color: "var(--text-secondary, #b0bac7)", fontSize: "var(--text-sm, 0.8125rem)", marginBottom: "var(--space-4, 1rem)" }}>{message}</p>
        <div style={{ display: "flex", gap: "var(--space-2, 0.5rem)", justifyContent: "flex-end", flexWrap: "wrap" }}>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            size="sm"
            onClick={onConfirm}
            disabled={busy}
            loading={busy}
          >
            {busy ? "Please wait…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
