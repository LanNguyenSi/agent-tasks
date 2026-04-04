import type { ReactNode } from "react";
import Card from "./Card";

interface EmptyStateProps {
  message: string;
  action?: ReactNode;
}

export default function EmptyState({ message, action }: EmptyStateProps) {
  return (
    <Card dashed style={{ textAlign: "center", padding: "3rem", color: "var(--muted)" }}>
      <p style={{ marginBottom: action ? "0.5rem" : 0 }}>{message}</p>
      {action}
    </Card>
  );
}
