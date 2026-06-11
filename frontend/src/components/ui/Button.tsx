// Button primitive — all geometry in CSS classes (globals.css .btn--*).
// Supports: primary / secondary / danger / outline-danger / ghost / link / link-danger variants,
// sm/md/lg sizes, loading spinner (label kept visible), optional KeyHint chip,
// and href prop (renders <a> with the same classes for link affordances).
//
// Call sites that pass style={{}} for layout override still work — those are
// caller-owned dynamic values, not component geometry.

import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  CSSProperties,
  ReactNode,
} from "react";
import { KeyHint } from "./KeyHint";

type Variant =
  | "primary"
  | "secondary"
  | "danger"
  | "outline-danger"
  | "ghost"
  | "link"
  | "link-danger";

interface ButtonBaseProps {
  variant?: Variant;
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  children: ReactNode;
  /** Renders a KeyHint chip after the label (inside the button). */
  keyHint?: string;
  /** When set, renders an <a> element instead of <button>. */
  href?: string;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
}

type ButtonProps = ButtonBaseProps &
  (
    | Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof ButtonBaseProps>
    | Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof ButtonBaseProps>
  );

const VARIANT_CLASS: Record<Variant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  danger: "btn-danger",
  "outline-danger": "btn-outline-danger",
  ghost: "btn-ghost",
  link: "btn-link",
  "link-danger": "btn-link btn-link-danger",
};

const SIZE_CLASS: Record<string, string> = {
  sm: "btn--sm",
  md: "btn--md",
  lg: "btn--lg",
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  children,
  disabled,
  className,
  keyHint,
  href,
  style,
  ...rest
}: ButtonProps) {
  const isLink = variant === "link" || variant === "link-danger";

  const classes = [
    VARIANT_CLASS[variant],
    !isLink ? `btn--box ${SIZE_CLASS[size]}` : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const content = (
    <>
      {loading && <span className="btn-spinner" aria-hidden="true" />}
      {children}
      {keyHint && <KeyHint>{keyHint}</KeyHint>}
      {loading && <span className="sr-only">Loading</span>}
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        className={classes}
        style={style}
        {...(rest as AnchorHTMLAttributes<HTMLAnchorElement>)}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      disabled={disabled || loading}
      className={classes}
      style={style}
      aria-busy={loading || undefined}
      {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}
    >
      {content}
    </button>
  );
}
