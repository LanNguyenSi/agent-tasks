import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";
import Select from "./Select";

interface FormFieldProps {
  label: string;
  children: ReactNode;
}

export default function FormField({ label, children }: FormFieldProps) {
  const id = useId();
  const child = isValidElement(children)
    ? (children as ReactElement<{ id?: string; ariaLabel?: string; "aria-label"?: string }>)
    : null;

  // Associate the visible label with its control. A native form element gets
  // the generated id and a matching htmlFor (or keeps its own id). The custom
  // Select renders its own internal id, so we give it an accessible name via
  // ariaLabel instead of pointing htmlFor at an element it doesn't expose.
  // Anything else is left untouched (the label stays a visible caption).
  let control: ReactNode = children;
  let htmlFor: string | undefined;
  if (child) {
    if ((child.type as unknown) === Select) {
      if (!child.props.ariaLabel && !child.props["aria-label"]) {
        control = cloneElement(child, { ariaLabel: label });
      }
    } else if (typeof child.type === "string") {
      if (child.props.id) {
        htmlFor = child.props.id;
      } else {
        control = cloneElement(child, { id });
        htmlFor = id;
      }
    }
  }

  return (
    <div>
      <label
        htmlFor={htmlFor}
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
      {control}
    </div>
  );
}
