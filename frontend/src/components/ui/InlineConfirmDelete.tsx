"use client";

// Two-step delete confirmation idiom.
//
// First click arms the control (shows "Confirm? / Cancel" inline).
// Confirming calls onConfirm; cancelling disarms without side effects.
// No modal, no external state required from the parent.
//
// Used for every delete affordance on the task detail surface:
// attachments, comments, dependencies, artifacts.

import { useState } from "react";
import { Button } from "./Button";

export interface InlineConfirmDeleteProps {
  onConfirm: () => void;
  /** Show a spinner / disable buttons while the parent's async delete runs. */
  busy?: boolean;
  /** Visible label for the initial (unarmed) button. Default: "Delete" */
  label?: string;
  /** Visible label shown in the armed confirm button. Default: "Confirm?" */
  confirmLabel?: string;
  /** aria-label for the initial button (for screen readers / tests). */
  ariaLabel?: string;
  /** aria-label for the armed confirm button. */
  confirmAriaLabel?: string;
  /** aria-label for the cancel button. */
  cancelAriaLabel?: string;
}

export default function InlineConfirmDelete({
  onConfirm,
  busy = false,
  label = "Delete",
  confirmLabel = "Confirm?",
  ariaLabel,
  confirmAriaLabel,
  cancelAriaLabel,
}: InlineConfirmDeleteProps) {
  const [armed, setArmed] = useState(false);

  if (armed) {
    return (
      <span className="inline-confirm-delete">
        <Button
          variant="link-danger"
          size="sm"
          onClick={onConfirm}
          disabled={busy}
          aria-label={confirmAriaLabel}
        >
          {busy ? "…" : confirmLabel}
        </Button>
        <Button
          variant="link"
          size="sm"
          onClick={() => setArmed(false)}
          disabled={busy}
          aria-label={cancelAriaLabel}
        >
          Cancel
        </Button>
      </span>
    );
  }

  return (
    <Button
      variant="link-danger"
      size="sm"
      onClick={() => setArmed(true)}
      disabled={busy}
      aria-label={ariaLabel}
    >
      {busy ? "…" : label}
    </Button>
  );
}
