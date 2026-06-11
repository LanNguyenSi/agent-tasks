"use client";

// Custom select / combobox. Geometry in .select-* classes in globals.css.
// Portal + position/flip logic shared with DropdownMenu via usePopover hook.
// Trigger height: 28px. Border radius: --radius-base.
//
// Call sites that pass className / style for layout overrides still work
// (those are caller-owned dynamic values on the wrapper div).

import { useState, useRef, useId, useCallback, useEffect, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { usePopover } from "./usePopover";

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** Kept for caller-owned dynamic layout overrides. */
  style?: CSSProperties;
  /** Accessible name for the combobox when no adjacent <label> is wired up. */
  ariaLabel?: string;
}

export default function Select({
  options,
  value,
  onChange,
  placeholder = "Select...",
  className = "",
  style,
  ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const id = useId();

  const selected = options.find((o) => o.value === value);
  const handleClose = useCallback(() => setOpen(false), []);

  // usePopover handles portal mounting, position computation, outside click,
  // and Escape-to-close.
  const { panelRef, positionStyle, positionReady, mounted } = usePopover({
    anchorRef: triggerRef,
    open,
    onClose: handleClose,
    align: "start",
    matchAnchorWidth: true,
    offset: 4,
  });

  function handleOpen() {
    setOpen(true);
    setActiveIndex(options.findIndex((o) => o.value === value));
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        handleOpen();
      }
      return;
    }
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        setOpen(false);
        break;
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => (i < options.length - 1 ? i + 1 : 0));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => (i > 0 ? i - 1 : options.length - 1));
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (activeIndex >= 0 && activeIndex < options.length) {
          onChange(options[activeIndex].value);
          setOpen(false);
        }
        break;
    }
  }

  // Scroll active option into view
  useEffect(() => {
    if (open && activeIndex >= 0 && listRef.current) {
      const item = listRef.current.children[activeIndex] as HTMLElement | undefined;
      item?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, open]);

  return (
    <div
      className={["select-wrapper", className].filter(Boolean).join(" ")}
      // eslint-disable-next-line no-restricted-syntax
      style={style} /* dynamic: caller-owned layout override */
    >
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${id}-opt-${activeIndex}` : undefined}
        onClick={() => (open ? setOpen(false) : handleOpen())}
        onKeyDown={handleKeyDown}
        className="select-trigger"
      >
        <span className="select-trigger-label">
          {selected ? (
            selected.label
          ) : (
            <span className="select-placeholder">{placeholder}</span>
          )}
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={["select-chevron", open ? "select-chevron--open" : ""].filter(Boolean).join(" ")}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open &&
        mounted &&
        createPortal(
          <div
            ref={(el) => {
              // Share the ref with both usePopover (for position computation)
              // and the local list ref (for scroll-into-view).
              (panelRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
              listRef.current = el;
            }}
            role="listbox"
            id={`${id}-list`}
            className="select-list"
            // eslint-disable-next-line no-restricted-syntax
            style={{
              /* dynamic: computed position from usePopover */
              ...positionStyle,
              /* dynamic: hidden until first position computation completes */
              visibility: positionReady ? "visible" : "hidden",
            }}
          >
            {options.length === 0 ? (
              <div className="select-empty">No options</div>
            ) : (
              options.map((opt, i) => (
                <div
                  key={opt.value}
                  id={`${id}-opt-${i}`}
                  role="option"
                  aria-selected={opt.value === value}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={[
                    "select-option",
                    opt.value === value ? "select-option--selected" : "",
                    i === activeIndex ? "select-option--active" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <span className="select-option-check" aria-hidden="true">
                    {opt.value === value && (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </span>
                  {opt.label}
                </div>
              ))
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
