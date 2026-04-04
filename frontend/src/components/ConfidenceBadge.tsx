"use client";

interface ConfidenceBadgeProps {
  score: number;
  size?: "sm" | "md";
}

function getColor(score: number): string {
  if (score < 40) return "var(--danger)";
  if (score <= 70) return "var(--warning, #e5a00d)";
  return "var(--success, #22c55e)";
}

export default function ConfidenceBadge({ score, size = "sm" }: ConfidenceBadgeProps) {
  const color = getColor(score);
  const fontSize = size === "sm" ? "var(--text-xs)" : "var(--text-sm)";

  return (
    <span
      title={`Confidence: ${score}/100`}
      className="status-chip"
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 55%, var(--border) 45%)`,
        fontSize,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {score}%
    </span>
  );
}
