import type { ReactNode } from "react";
import Card from "./Card";

interface EmptyStateProps {
  message: string;
  action?: ReactNode;
}

export default function EmptyState({ message, action }: EmptyStateProps) {
  return (
    <Card dashed style={{ textAlign: "center", padding: "var(--space-8, 2rem)", color: "var(--muted)" }}>
      <p style={{ marginBottom: action ? "var(--space-2, 0.5rem)" : 0 }}>{message}</p>
      {action}
    </Card>
  );
}
