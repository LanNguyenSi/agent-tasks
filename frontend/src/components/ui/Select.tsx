"use client";

import { useState, useRef, useEffect, useCallback, useId } from "react";

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
  style?: React.CSSProperties;
}

export default function Select({ options, value, onChange, placeholder = "Select...", className = "", style }: SelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const selected = options.find((o) => o.value === value);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      setActiveIndex(options.findIndex((o) => o.value === value));
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open, handleClickOutside, options, value]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case "Escape": e.preventDefault(); setOpen(false); break;
      case "ArrowDown": e.preventDefault(); setActiveIndex((i) => (i < options.length - 1 ? i + 1 : 0)); break;
      case "ArrowUp": e.preventDefault(); setActiveIndex((i) => (i > 0 ? i - 1 : options.length - 1)); break;
      case "Enter": case " ":
        e.preventDefault();
        if (activeIndex >= 0 && activeIndex < options.length) {
          onChange(options[activeIndex].value);
          setOpen(false);
        }
        break;
    }
  }

  useEffect(() => {
    if (open && activeIndex >= 0 && listRef.current) {
      const item = listRef.current.children[activeIndex] as HTMLElement | undefined;
      item?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, open]);

  return (
    <div ref={containerRef} className={className} style={{ position: "relative", ...style }}>
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${id}-opt-${activeIndex}` : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={handleKeyDown}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "8px",
          padding: "0.45rem 0.625rem",
          fontSize: "var(--text-sm)",
          color: selected ? "var(--text)" : "var(--muted)",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected ? selected.label : placeholder}
        </span>
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          style={{ flexShrink: 0, opacity: 0.5, transition: "transform 150ms", transform: open ? "rotate(180deg)" : "" }}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          id={`${id}-list`}
          style={{
            position: "absolute",
            zIndex: 50,
            top: "calc(100% + 4px)",
            left: 0,
            width: "100%",
            background: "var(--surface)",
            border: "1px solid var(--border-hover)",
            borderRadius: "8px",
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            padding: "4px",
            maxHeight: "200px",
            overflowY: "auto",
          }}
        >
          {options.length === 0 ? (
            <div style={{ padding: "0.5rem", fontSize: "var(--text-sm)", color: "var(--muted)" }}>No options</div>
          ) : (
            options.map((opt, i) => (
              <div
                key={opt.value}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={opt.value === value}
                onClick={() => { onChange(opt.value); setOpen(false); }}
                onMouseEnter={() => setActiveIndex(i)}
                style={{
                  padding: "0.4rem 0.5rem",
                  fontSize: "var(--text-sm)",
                  borderRadius: "6px",
                  cursor: "pointer",
                  color: opt.value === value ? "var(--primary)" : "var(--text)",
                  background: i === activeIndex ? "var(--border)" : "transparent",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.4rem",
                }}
              >
                {opt.value === value ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ flexShrink: 0 }}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <span style={{ width: "14px", flexShrink: 0 }} />
                )}
                {opt.label}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
