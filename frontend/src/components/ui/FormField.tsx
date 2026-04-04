import type { ReactNode } from "react";

interface FormFieldProps {
  label: string;
  children: ReactNode;
}

export default function FormField({ label, children }: FormFieldProps) {
  return (
    <div>
      <label
        style={{
          display: "block",
          color: "var(--text-secondary, #b0bac7)",
          fontSize: "var(--text-xs, 0.75rem)",
          fontWeight: 500,
          marginBottom: "var(--space-1, 0.25rem)",
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}
