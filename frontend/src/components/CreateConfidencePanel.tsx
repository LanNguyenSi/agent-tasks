import { useEffect, useRef } from "react";
import type { CreateConfidence } from "../lib/api";
import ConfidenceBadge from "./ConfidenceBadge";
import { Button } from "./ui/Button";

/** camelCase templateData key -> human label, e.g. "acceptanceCriteria" ->
 *  "Acceptance Criteria". Keeps the missing-fields line readable without a
 *  brittle per-key map. */
function humanizeField(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

// Defensive cap matching the spec's "top nextActions"; the backend already
// dedupes + caps at 5 (deriveNextActions), this just guarantees the modal list
// stays bounded if that ever changes.
const MAX_NEXT_ACTIONS = 5;

/**
 * Renders the server-computed create-time confidence after a task is created:
 * the authoritative scorer-v2 score vs the project threshold, the missing
 * fields, and the top nextActions. Distinct from the live in-form badge (which
 * recomputes client-side as the user types); this is the backend's verdict for
 * the task that was actually persisted. On mount it takes focus and announces
 * the verdict so the form-to-panel swap is reachable for keyboard / screen-reader
 * users.
 */
export default function CreateConfidencePanel({
  confidence,
  assignmentError,
  onEdit,
  onClose,
}: {
  confidence: CreateConfidence;
  assignmentError?: string | null;
  /** Open the just-created task in the editor to act on the missing fields. */
  onEdit: () => void;
  onClose: () => void;
}) {
  const { score, threshold, blocking, missing, nextActions } = confidence;
  const passes = score >= threshold && !blocking;

  // The Modal's focus effect only runs on open, not on this in-place content
  // swap, so focus would fall to document.body. Pull it into the panel.
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  return (
    <div ref={containerRef} tabIndex={-1} className="ccp-root">
      <p className="ccp-created">Task created.</p>

      {assignmentError && (
        <p role="alert" className="ccp-error">{assignmentError}</p>
      )}

      <div role="status" aria-live="polite" className="ccp-verdict-row">
        <ConfidenceBadge score={score} size="md" />
        <span className={`ccp-verdict-text ${passes ? "ccp-verdict-text--pass" : "ccp-verdict-text--fail"}`}>
          {passes
            ? `At or above the ${threshold} threshold`
            : `Below the ${threshold} threshold: agents cannot claim this task`}
        </span>
      </div>

      {missing.length > 0 && (
        <p className="ccp-missing">
          Missing: {missing.map(humanizeField).join(", ")}
        </p>
      )}

      {nextActions.length > 0 && (
        <div className="ccp-next-steps">
          <p className="ccp-next-steps-heading">Next steps to raise confidence</p>
          <ul className="ccp-next-steps-list">
            {nextActions.slice(0, MAX_NEXT_ACTIONS).map((action) => (
              <li key={action} className="ccp-next-steps-item">{action}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="ccp-actions">
        <Button type="button" size="sm" onClick={onEdit}>
          Edit task
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}
