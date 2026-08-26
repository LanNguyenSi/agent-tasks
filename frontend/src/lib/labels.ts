// Client-side mirror of the label limits `updateTaskSchema` enforces
// server-side (backend/src/routes/tasks.ts:
// `z.array(z.string().trim().min(1).max(100)).max(20)`). Keeping these in
// sync lets the UI reject an invalid label before the PATCH round-trip
// instead of surfacing a raw 400 from the backend.

export const LABEL_MAX_LENGTH = 100;
export const LABELS_MAX_COUNT = 20;

/**
 * Validates a single candidate label against the schema limits, given the
 * task's current label set. Returns null when valid, or a user-facing
 * reason otherwise. Does not mutate `existingLabels`.
 */
export function validateNewLabel(
  raw: string,
  existingLabels: string[],
): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return "Label cannot be empty.";
  }
  if (trimmed.length > LABEL_MAX_LENGTH) {
    return `Label must be ${LABEL_MAX_LENGTH} characters or fewer.`;
  }
  const existingMatch = existingLabels.find(
    (l) => l.toLowerCase() === trimmed.toLowerCase(),
  );
  if (existingMatch) {
    return `That label is already on this task (as "${existingMatch}").`;
  }
  if (existingLabels.length >= LABELS_MAX_COUNT) {
    return `A task can have at most ${LABELS_MAX_COUNT} labels.`;
  }
  return null;
}
