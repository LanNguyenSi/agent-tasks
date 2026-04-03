import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  children: ReactNode;
}

const variantStyles: Record<string, CSSProperties> = {
  primary: { background: "var(--primary)", color: "white", border: "none" },
  secondary: { background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" },
  danger: { background: "var(--danger)", color: "white", border: "none" },
  ghost: { background: "transparent", color: "var(--muted)", border: "1px solid var(--border)" },
};

const sizeStyles: Record<string, CSSProperties> = {
  sm: { padding: "0.25rem 0.75rem", fontSize: "0.8125rem" },
  md: { padding: "0.5rem 1.25rem", fontSize: "0.875rem" },
  lg: { padding: "0.75rem 1.75rem", fontSize: "1rem" },
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  children,
  disabled,
  style,
  ...props
}: ButtonProps) {
  return (
    <button
      disabled={disabled || loading}
      style={{
        borderRadius: "8px",
        fontWeight: 600,
        cursor: disabled || loading ? "not-allowed" : "pointer",
        opacity: disabled || loading ? 0.6 : 1,
        transition: "opacity 0.15s",
        fontFamily: "inherit",
        ...variantStyles[variant],
        ...sizeStyles[size],
        ...style,
      }}
      {...props}
    >
      {loading ? "…" : children}
    </button>
  );
}
