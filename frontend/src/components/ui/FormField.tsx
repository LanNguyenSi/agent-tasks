// FormField: associates a label with its control.
// All geometry in .form-field-label class in globals.css.
// Optional hint: muted helper text rendered below the control.

import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";
import Select from "./Select";

interface FormFieldProps {
  label: string;
  children: ReactNode;
  /** Muted helper text shown below the control. */
  hint?: string;
}

export default function FormField({ label, children, hint }: FormFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const child = isValidElement(children)
    ? (children as ReactElement<{
        id?: string;
        ariaLabel?: string;
        "aria-label"?: string;
        ariaDescribedBy?: string;
      }>)
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
      const overrides: { ariaLabel?: string; ariaDescribedBy?: string } = {};
      if (!child.props.ariaLabel && !child.props["aria-label"]) {
        overrides.ariaLabel = label;
      }
      // Review round 1 fix (task 31528564): when there's a hint (e.g. the
      // Assignee "why disabled" copy), wire it up via aria-describedby so
      // screen-reader users hear the reason, not just the aria-disabled state.
      if (hint && !child.props.ariaDescribedBy) {
        overrides.ariaDescribedBy = hintId;
      }
      if (Object.keys(overrides).length > 0) {
        control = cloneElement(child, overrides);
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
    <div className="form-field">
      <label htmlFor={htmlFor} className="form-field-label">
        {label}
      </label>
      {control}
      {hint && (
        <p id={hintId} className="form-field-hint">
          {hint}
        </p>
      )}
    </div>
  );
}
