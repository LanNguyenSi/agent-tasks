import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";

type Variant = "primary" | "secondary" | "danger" | "outline-danger" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  children: ReactNode;
}

const variantClass: Record<Variant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  danger: "btn-danger",
  "outline-danger": "btn-outline-danger",
  ghost: "btn-ghost",
};

const sizeStyles: Record<string, CSSProperties> = {
  sm: { padding: "0.35rem 0.75rem", fontSize: "var(--text-sm, 0.8125rem)" },
  md: { padding: "0.5rem 1.25rem", fontSize: "var(--text-base, 0.875rem)" },
  lg: { padding: "0.75rem 1.75rem", fontSize: "var(--text-md, 1rem)" },
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  children,
  disabled,
  style,
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      disabled={disabled || loading}
      className={[variantClass[variant], className].filter(Boolean).join(" ")}
      style={{
        borderRadius: "var(--radius-base, 6px)",
        fontWeight: 600,
        cursor: disabled || loading ? "not-allowed" : "pointer",
        opacity: disabled || loading ? 0.4 : 1,
        fontFamily: "inherit",
        ...sizeStyles[size],
        ...style,
      }}
      {...props}
    >
      {loading ? "…" : children}
    </button>
  );
}
