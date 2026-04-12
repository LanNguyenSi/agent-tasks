/**
 * Shared inline styles for the workflow editor components.
 *
 * Kept inline (not CSS-modules or Tailwind) to match the existing
 * repo style. Extracted into a single file so the page, StatesTable,
 * TransitionsTable, and future components all reference the same
 * definitions — no copy-paste drift, no style divergence between
 * read-only and editable table rows.
 */

export const th: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.75rem",
  fontWeight: 600,
  color: "var(--muted)",
  fontSize: "var(--text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

export const td: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  verticalAlign: "top",
};

export const pill: React.CSSProperties = {
  display: "inline-block",
  padding: "0.125rem 0.5rem",
  borderRadius: "999px",
  background: "color-mix(in srgb, var(--primary, #3b82f6) 15%, transparent)",
  color: "var(--primary, #3b82f6)",
  fontSize: "var(--text-xs)",
  fontWeight: 600,
};

export const inlineInput: React.CSSProperties = {
  width: "100%",
  padding: "0.25rem 0.5rem",
  fontSize: "var(--text-sm)",
  fontFamily: "inherit",
  background: "var(--input-bg, transparent)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm, 4px)",
};

export const inlineSelect: React.CSSProperties = {
  padding: "0.25rem 0.5rem",
  fontSize: "var(--text-sm)",
  fontFamily: "inherit",
  background: "var(--input-bg, transparent)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm, 4px)",
};

export const linkButton: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  color: "var(--primary, #3b82f6)",
  cursor: "pointer",
  fontSize: "var(--text-xs)",
  textDecoration: "underline",
};
