import type { CSSProperties, ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  padding?: "sm" | "md";
  dashed?: boolean;
  interactive?: boolean;
  style?: CSSProperties;
}

const paddingMap = { sm: "var(--space-3, 0.75rem) var(--space-4, 1rem)", md: "var(--space-4, 1rem)" };

export default function Card({
  children,
  className,
  padding = "md",
  dashed = false,
  interactive = false,
  style,
}: CardProps) {
  return (
    <div
      className={className}
      style={{
        background: dashed ? "transparent" : "var(--surface)",
        border: `1px ${dashed ? "dashed" : "solid"} var(--border)`,
        borderRadius: "var(--radius-lg, 10px)",
        padding: paddingMap[padding],
        transition: interactive ? "border-color 0.15s ease, box-shadow 0.15s ease" : undefined,
        cursor: interactive ? "pointer" : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
