"use client";

// Modal dialog with fixed header, scrolling body, and pinned footer.
// Header/body/footer slots exposed via props; existing children-only call
// sites are unaffected (children renders in the body, actions in the footer).
//
// footer prop is an alias for actions. body prop is an alias for children.
// Both the old and new names work at any call site.

import { useEffect, useId, useRef, type ReactNode } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Body content. Alias: body prop. */
  children?: ReactNode;
  /** Footer actions row. Alias: footer prop. */
  actions?: ReactNode;
  /**
   * Optional controls rendered in the header to the left of the close
   * button (e.g. a "maximize to full page" affordance). Kept additive so
   * existing consumers are unaffected.
   */
  headerActions?: ReactNode;
  /**
   * Close the dialog when Escape is pressed. Default `true`. Set `false`
   * when the consumer owns richer Escape handling (e.g. cancel an inline
   * edit before closing) so the two handlers do not double-fire.
   */
  closeOnEscape?: boolean;
  /** Slot alias for children. When both are set, footer wins. */
  body?: ReactNode;
  /** Slot alias for actions. When both are set, footer wins. */
  footer?: ReactNode;
}

export default function Modal({
  open,
  onClose,
  title,
  children,
  actions,
  headerActions,
  closeOnEscape = true,
  body,
  footer,
}: ModalProps) {
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Slot resolution: explicit slot props win over the legacy props.
  const bodyContent = body ?? children;
  const footerContent = footer ?? actions;

  // Focus management: move focus into the dialog on open, restore it to
  // the previously-focused element (the trigger) on close/unmount.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();
    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  // Escape-to-close + a lightweight focus trap, scoped to the open dialog.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && closeOnEscape) {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const card = cardRef.current;
      if (!card) return;
      const focusables = card.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, closeOnEscape, onClose]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={cardRef}
        // `modal-card--framed` opts this card into the sticky-header /
        // scrolling-body / pinned-footer layout. ConfirmDialog reuses the
        // bare `.modal-card` (flat, self-padded) and intentionally omits it.
        className="modal-card modal-card--framed"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 className="modal-title" id={titleId}>
            {title}
          </h3>
          <div className="modal-header-actions">
            {headerActions}
            <button
              type="button"
              className="modal-close"
              onClick={onClose}
              aria-label="Close"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        <div className="modal-body">{bodyContent}</div>
        {footerContent && <div className="modal-actions">{footerContent}</div>}
      </div>
    </div>
  );
}
