import type { CSSProperties, ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  padding?: "sm" | "md";
  dashed?: boolean;
  style?: CSSProperties;
}

const paddingMap = { sm: "0.75rem 0.9rem", md: "1rem" };

export default function Card({
  children,
  className,
  padding = "md",
  dashed = false,
  style,
}: CardProps) {
  return (
    <div
      className={className}
      style={{
        background: dashed ? "transparent" : "var(--surface)",
        border: `1px ${dashed ? "dashed" : "solid"} var(--border)`,
        borderRadius: "10px",
        padding: paddingMap[padding],
        ...style,
      }}
    >
      {children}
    </div>
  );
}
