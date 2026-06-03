// Priority chip colors, mapped to theme-aware design tokens so they adapt
// to light/dark and stay consistent across every task surface. Single
// source of truth: previously duplicated as raw hex in four files (home
// diverged on LOW). Keys are the task Priority enum values; consumers
// index with task.priority. CRITICAL uses --danger-strong, a darker red
// than HIGH's --danger so the two top levels stay distinguishable.
export const PRIORITY_COLORS: Record<string, string> = {
  LOW: "var(--muted)",
  MEDIUM: "var(--warning)",
  HIGH: "var(--danger)",
  CRITICAL: "var(--danger-strong)",
};
