// GFM checklist counting for the task-detail "X of Y checked" indicator.

/**
 * Parse GFM task-list items in a markdown string. Returns null when none
 * found. Counts indented (nested) items and all three bullet markers.
 *
 * Line-regex approximation of what remark-gfm renders: it also counts
 * checkbox-looking lines inside code blocks (fenced or indented), and it
 * misses ordered-list (`1. [ ]`), blockquote (`> - [ ]`), and
 * extra-space-after-bullet variants. All are rare in task descriptions;
 * the counter is cosmetic.
 */
export function parseChecklistProgress(
  text: string,
): { checked: number; total: number } | null {
  const matches = text.match(/^\s*[-*+] \[[ xX]\]/gm);
  if (!matches || matches.length === 0) return null;
  const checked = matches.filter((m) => !m.endsWith("[ ]")).length;
  return { checked, total: matches.length };
}
