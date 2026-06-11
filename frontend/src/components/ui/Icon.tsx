// Inline SVG icon set on a 16px grid, 1.5px stroke, currentColor.
// Path data taken from quiet-precision mockup symbol defs where present;
// missing icons drawn in the same style.
//
// Usage: <Icon name="search" size={16} />
// Accessibility: aria-hidden by default; pass label prop to set aria-label.

import type { SVGProps, ReactElement } from "react";

export type IconName =
  | "search"
  | "filter"
  | "board"
  | "list"
  | "plus"
  | "calendar"
  | "branch"
  | "pr"
  | "chevron-down"
  | "chevron-right"
  | "dots"
  | "check"
  | "edit"
  | "clip"
  | "box"
  | "x"
  | "arrow-right";

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
  /** When set, overrides aria-hidden and sets aria-label on the SVG. */
  label?: string;
}

// SVG path definitions keyed by icon name. All draw on a 16×16 grid.
const ICON_PATHS: Record<IconName, () => ReactElement> = {
  search: () => (
    <>
      <circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="m10.2 10.2 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),

  filter: () => (
    <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3" />
    </g>
  ),

  board: () => (
    <>
      <rect x="2" y="2.5" width="3.3" height="11" rx="1" fill="currentColor" />
      <rect x="6.35" y="2.5" width="3.3" height="7.5" rx="1" fill="currentColor" />
      <rect x="10.7" y="2.5" width="3.3" height="9.5" rx="1" fill="currentColor" />
    </>
  ),

  list: () => (
    <g stroke="currentColor" strokeLinecap="round">
      <path d="M5.5 4h8M5.5 8h8M5.5 12h8" strokeWidth="1.5" />
      <path d="M2.5 4h.01M2.5 8h.01M2.5 12h.01" strokeWidth="2" />
    </g>
  ),

  plus: () => (
    <path
      d="M8 3.25v9.5M3.25 8h9.5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  ),

  calendar: () => (
    <>
      <rect
        x="2.5"
        y="3.5"
        width="11"
        height="10"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M2.5 6.75h11M5.5 1.75v3M10.5 1.75v3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </>
  ),

  branch: () => (
    <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="3.5" r="1.6" />
      <path d="M4 5.5v5M12 5.5c0 3.5-8 2-8 5.5" />
    </g>
  ),

  pr: () => (
    <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="12.5" r="1.6" />
      <path d="M4 5.5v5M8.5 3.5H10A2 2 0 0 1 12 5.5v5" />
    </g>
  ),

  "chevron-down": () => (
    <path
      d="M4.5 6.25 8 9.75l3.5-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),

  "chevron-right": () => (
    <path
      d="M6.25 4.5 9.75 8l-3.5 3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),

  dots: () => (
    <>
      <circle cx="3.5" cy="8" r="1.2" fill="currentColor" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.2" fill="currentColor" />
    </>
  ),

  check: () => (
    <path
      d="m3.5 8.5 3 3 6-7"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),

  edit: () => (
    <path
      d="M11.2 2.8a1.55 1.55 0 0 1 2.2 2.2L5.2 13.2 2.5 13.9l.7-2.7 8-8.4Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  ),

  clip: () => (
    <path
      d="m12.6 7.2-4.7 4.7a2.6 2.6 0 0 1-3.7-3.7l4.9-4.9a1.75 1.75 0 0 1 2.5 2.5L6.9 10.5a.9.9 0 0 1-1.3-1.3l4.2-4.2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),

  box: () => (
    <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M8 1.8 13.5 4.7v6.6L8 14.2l-5.5-2.9V4.7L8 1.8Z" />
      <path d="M2.5 4.7 8 7.7l5.5-3M8 7.7v6.5" />
    </g>
  ),

  x: () => (
    <path
      d="M3.5 3.5 12.5 12.5M12.5 3.5 3.5 12.5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  ),

  "arrow-right": () => (
    <path
      d="M3 8h9.5M9 4.5 12.5 8 9 11.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
};

export function Icon({ name, size = 16, label, className, ...props }: IconProps) {
  const PathContent = ICON_PATHS[name];
  const accessibilityProps = label
    ? { "aria-label": label, role: "img" as const }
    : { "aria-hidden": true as const };

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={["icon", className].filter(Boolean).join(" ")}
      {...accessibilityProps}
      {...props}
    >
      <PathContent />
    </svg>
  );
}
