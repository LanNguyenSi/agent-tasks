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
          color: "var(--muted)",
          fontSize: "0.75rem",
          marginBottom: "0.25rem",
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}
