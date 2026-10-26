/** camelCase templateData key -> human label, e.g. "acceptanceCriteria" ->
 *  "Acceptance Criteria". Keeps the "Missing:" lines readable without a
 *  brittle per-key map. */
export function humanizeField(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}
