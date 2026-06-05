"use client";

import ConfidenceBadge from "./ConfidenceBadge";

const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  description: "Description",
  goal: "Goal",
  acceptanceCriteria: "Acceptance criteria",
  context: "Context",
  constraints: "Constraints",
};

interface TaskConfidenceSummaryProps {
  score: number;
  missing: string[];
  threshold: number;
  label?: string;
}

function formatMissingField(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

export default function TaskConfidenceSummary({
  score,
  missing,
  threshold,
  label = "Confidence",
}: TaskConfidenceSummaryProps) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "10px",
        padding: "0.7rem 0.8rem",
        background: "color-mix(in srgb, var(--surface) 88%, var(--surface-elevated, white) 12%)",
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "0.5rem",
          marginBottom: missing.length > 0 || score < threshold ? "0.35rem" : 0,
        }}
      >
        <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>{label}</span>
        <ConfidenceBadge score={score} />
        {score < threshold && (
          <span style={{ fontSize: "var(--text-xs)", color: "var(--danger)" }}>
            Below threshold ({threshold}) — agents cannot claim this task yet
          </span>
        )}
      </div>
      {missing.length > 0 && (
        <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--muted)" }}>
          Missing: {missing.map(formatMissingField).join(", ")}
        </p>
      )}
    </div>
  );
}
