import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";

type Variant = "primary" | "secondary" | "danger" | "outline-danger" | "ghost" | "link" | "link-danger";

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
  link: "btn-link",
  "link-danger": "btn-link btn-link-danger",
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
  // The link / link-danger variants render as unboxed inline text (no
  // padding, background, or radius) so they sit inside chips and metadata
  // rows without looking like a button. Colour + underline come from the
  // .btn-link CSS class.
  const isLink = variant === "link" || variant === "link-danger";
  return (
    <button
      disabled={disabled || loading}
      className={[variantClass[variant], className].filter(Boolean).join(" ")}
      style={{
        cursor: disabled || loading ? "not-allowed" : "pointer",
        opacity: disabled || loading ? 0.4 : 1,
        fontFamily: "inherit",
        ...(isLink
          ? { background: "none", border: "none", padding: 0, fontWeight: 600 }
          : { borderRadius: "var(--radius-base, 6px)", fontWeight: 600, ...sizeStyles[size] }),
        ...style,
      }}
      {...props}
      aria-busy={loading || undefined}
    >
      {children}
      {loading && <span className="sr-only">Loading</span>}
    </button>
  );
}
