"use client";

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
        <h3 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "0.45rem" }}>{title}</h3>
        <p style={{ color: "var(--muted)", fontSize: "0.86rem", marginBottom: "0.9rem" }}>{message}</p>
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{
              background: "transparent",
              color: "var(--muted)",
              border: "1px solid var(--border)",
              borderRadius: "8px",
              padding: "0.45rem 0.9rem",
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            style={{
              background: tone === "danger" ? "var(--danger)" : "var(--primary)",
              color: "white",
              border: "none",
              borderRadius: "8px",
              padding: "0.45rem 0.9rem",
              opacity: busy ? 0.75 : 1,
              fontWeight: 600,
            }}
          >
            {busy ? "Please wait…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
