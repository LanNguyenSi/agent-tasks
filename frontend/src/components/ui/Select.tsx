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
  /** Searchable mode only: text matched by PREFIX (e.g. the full task id), so a
   *  query never matches in the middle of it. The label is matched as a
   *  substring. */
  idPrefix?: string;
  /** Secondary text rendered after the label (e.g. "abcd1234 · open"). Never
   *  matched by the filter; put a matchable id in idPrefix. */
  detail?: string;
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
  /** Disables the trigger; the listbox cannot be opened while true. Uses the
   *  aria-disabled pattern (not the native `disabled` attribute) so the
   *  trigger stays focusable and reachable by keyboard/screen-reader users
   *  even while unavailable -- see the .select-trigger[aria-disabled] rule
   *  in globals.css and the guarded open/keydown/click handlers below. */
  disabled?: boolean;
  /** id of an element (e.g. a FormField hint) that explains WHY the control
   *  is disabled; wired to aria-describedby so screen readers announce it. */
  ariaDescribedBy?: string;
  /** Opt-in: replaces the button trigger with a text input (WAI-ARIA combobox
   *  with list autocomplete) that filters options case-insensitively by label
   *  substring or idPrefix prefix. The input value is always the query; the
   *  chosen option is shown as a placeholder and a read-only label. Options with an empty value (the "clear" row) are only
   *  listed while the query is empty. Default false: behaviour unchanged. */
  searchable?: boolean;
  /** Text of the empty row in searchable mode when nothing matches. */
  emptyText?: string;
}

function optionText(o: SelectOption): string {
  return o.detail ? `${o.label} (${o.detail})` : o.label;
}

export default function Select({
  options,
  value,
  onChange,
  placeholder = "Select...",
  className = "",
  style,
  ariaLabel,
  disabled = false,
  ariaDescribedBy,
  searchable = false,
  emptyText = "No matching options",
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement | HTMLInputElement | null>(null);
  // Searchable: the popover anchors on the input + chevron wrapper, so a press
  // on the chevron counts as "inside" and the chevron can toggle on its own.
  const searchRef = useRef<HTMLDivElement | null>(null);
  const id = useId();

  const selected = options.find((o) => o.value === value);
  const needle = query.trim().toLowerCase();
  const visible = searchable
    ? options.filter((o) =>
        needle === ""
          ? true
          : o.value !== "" &&
            (o.label.toLowerCase().includes(needle) ||
              (o.idPrefix ?? "").toLowerCase().startsWith(needle)),
      )
    : options;
  // The empty-value row is the "nothing chosen" state: show its label as a
  // placeholder instead of text, so typing never appends to it.
  const chosen = selected && selected.value !== "" ? selected : undefined;
  const handleClose = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  // usePopover handles portal mounting, position computation, outside click,
  // and Escape-to-close.
  const { panelRef, positionStyle, positionReady, mounted } = usePopover({
    anchorRef: searchable ? searchRef : triggerRef,
    open,
    onClose: handleClose,
    align: "start",
    matchAnchorWidth: true,
    offset: 4,
  });

  function handleOpen() {
    setOpen(true);
    setQuery("");
    setActiveIndex(options.findIndex((o) => o.value === value));
  }

  function pick(v: string) {
    onChange(v);
    handleClose();
  }

  function handleQueryChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (disabled) return;
    const q = e.target.value;
    setQuery(q);
    setOpen(true);
    // First match is active so Enter picks it straight away.
    setActiveIndex(q.trim() === "" ? -1 : 0);
  }

  // Guards the trigger's click behavior under the aria-disabled pattern: the
  // button stays focusable/tab-reachable (no native `disabled` attribute),
  // so the handler itself is what suppresses interaction while disabled.
  function handleTriggerClick() {
    if (disabled) return;
    // In the text input a click while open is a caret move: it must neither
    // close the list nor drop the query. The chevron and Escape close.
    if (searchable && open) return;
    if (open) {
      handleClose();
    } else {
      handleOpen();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", ...(searchable ? [] : [" "])].includes(e.key)) {
        e.preventDefault();
        handleOpen();
      }
      return;
    }
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        handleClose();
        break;
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => (i < visible.length - 1 ? i + 1 : 0));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => (i > 0 ? i - 1 : visible.length - 1));
        break;
      case "Enter":
      case " ":
        // Space types a character in the search input.
        if (e.key === " " && searchable) break;
        e.preventDefault();
        if (activeIndex >= 0 && activeIndex < visible.length) {
          pick(visible[activeIndex].value);
        }
        break;
    }
  }

  // Scroll active option into view
  useEffect(() => {
    if (open && activeIndex >= 0 && panelRef.current) {
      const item = panelRef.current.children[activeIndex] as HTMLElement | undefined;
      item?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, open, panelRef]);

  return (
    <div
      className={["select-wrapper", className].filter(Boolean).join(" ")}
      // eslint-disable-next-line no-restricted-syntax
      style={style} /* dynamic: caller-owned layout override */
    >
      {searchable ? (
        <div className="select-search" ref={searchRef}>
          <input
            ref={(el) => {
              triggerRef.current = el;
            }}
            type="text"
            role="combobox"
            autoComplete="off"
            aria-label={ariaLabel}
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-autocomplete="list"
            aria-controls={open ? `${id}-list` : undefined}
            aria-activedescendant={open && activeIndex >= 0 && activeIndex < visible.length ? `${id}-opt-${activeIndex}` : undefined}
            aria-disabled={disabled || undefined}
            // After a pick the input is empty (value === query) and the visible
            // label is aria-hidden, so the chosen task reaches assistive tech as
            // the field's description.
            aria-describedby={
              [ariaDescribedBy, chosen && !open ? `${id}-chosen` : undefined].filter(Boolean).join(" ") || undefined
            }
            readOnly={disabled}
            value={query}
            placeholder={chosen ? optionText(chosen) : (selected?.label ?? placeholder)}
            onChange={handleQueryChange}
            onClick={handleTriggerClick}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              if (open) handleClose();
            }}
            className={["select-trigger", "select-search-input", chosen && !open ? "select-search-input--chosen" : ""].filter(Boolean).join(" ")}
          />
          {chosen && !open && (
            // Visual twin of the placeholder (which stays for assistive tech):
            // only the title truncates, id and status always stay visible.
            <span id={`${id}-chosen`} className="select-search-chosen" aria-hidden="true">
              <span className="select-search-chosen-label">{chosen.label}</span>
              {chosen.detail && <span className="select-search-chosen-detail">({chosen.detail})</span>}
            </span>
          )}
          <svg
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (disabled) return;
              if (open) {
                handleClose();
              } else {
                triggerRef.current?.focus();
                handleOpen();
              }
            }}
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={["select-chevron", "select-search-chevron", open ? "select-chevron--open" : ""].filter(Boolean).join(" ")}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      ) : (
      <button
        ref={(el) => {
          triggerRef.current = el;
        }}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${id}-opt-${activeIndex}` : undefined}
        aria-disabled={disabled || undefined}
        aria-describedby={ariaDescribedBy}
        onClick={handleTriggerClick}
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
      )}

      {open &&
        mounted &&
        createPortal(
          <div
            // One ref serves usePopover (position computation) and the
            // scroll-into-view effect above.
            ref={panelRef}
            role="listbox"
            // Searchable: a mousedown on the list padding or scrollbar must not
            // blur the input (blur closes the list).
            onMouseDown={searchable ? (e) => e.preventDefault() : undefined}
            aria-label={searchable ? ariaLabel : undefined}
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
            {visible.length === 0 ? (
              searchable ? (
                // An option-role row keeps the listbox's required children
                // valid for assistive tech.
                <div className="select-empty" role="option" aria-disabled="true" aria-selected="false">
                  {emptyText}
                </div>
              ) : (
                <div className="select-empty">No options</div>
              )
            ) : (
              visible.map((opt, i) => (
                <div
                  key={opt.value}
                  id={`${id}-opt-${i}`}
                  role="option"
                  aria-selected={opt.value === value}
                  // Keep focus in the search input while clicking an option.
                  onMouseDown={searchable ? (e) => e.preventDefault() : undefined}
                  onClick={() => pick(opt.value)}
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
                  {opt.detail && <span className="select-option-detail">{opt.detail}</span>}
                </div>
              ))
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
