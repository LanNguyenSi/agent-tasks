// Segmented control / tablist.
// Roving tabindex: ArrowLeft/ArrowRight moves focus between tabs.
// Controlled: caller owns value + onChange.
// Geometry in .tabs / .tabs-tab in globals.css.
//
// Usage:
//   const [tab, setTab] = useState("board");
//   <Tabs value={tab} onChange={setTab} tabs={[
//     { value: "board", label: "Board", icon: <Icon name="board" size={14} /> },
//     { value: "list",  label: "List",  icon: <Icon name="list"  size={14} /> },
//   ]} />

import { useRef, type KeyboardEvent, type ReactNode } from "react";

export interface TabItem {
  value: string;
  label: string;
  icon?: ReactNode;
}

interface TabsProps {
  tabs: TabItem[];
  value: string;
  onChange: (value: string) => void;
  /** Optional aria-label for the tablist group. */
  label?: string;
  className?: string;
}

export function Tabs({ tabs, value, onChange, label, className }: TabsProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    const count = tabs.length;
    let nextIndex = currentIndex;

    if (e.key === "ArrowRight") {
      e.preventDefault();
      nextIndex = (currentIndex + 1) % count;
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      nextIndex = (currentIndex - 1 + count) % count;
    } else if (e.key === "Home") {
      e.preventDefault();
      nextIndex = 0;
    } else if (e.key === "End") {
      e.preventDefault();
      nextIndex = count - 1;
    } else {
      return;
    }

    // Move focus to the next tab button
    const buttons = containerRef.current?.querySelectorAll<HTMLButtonElement>("[role=tab]");
    buttons?.[nextIndex]?.focus();
    onChange(tabs[nextIndex].value);
  }

  return (
    <div
      ref={containerRef}
      role="tablist"
      aria-label={label}
      className={["tabs", className].filter(Boolean).join(" ")}
    >
      {tabs.map((tab, index) => {
        const isSelected = tab.value === value;
        return (
          <button
            key={tab.value}
            role="tab"
            aria-selected={isSelected}
            tabIndex={isSelected ? 0 : -1}
            className="tabs-tab"
            onClick={() => onChange(tab.value)}
            onKeyDown={(e) => handleKeyDown(e, index)}
          >
            {tab.icon}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
