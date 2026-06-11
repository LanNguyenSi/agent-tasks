// Component library v2 gallery — renders every B1 primitive in every state.
// No auth dependency. Theme toggle persists to localStorage.
// Route: /dev/ui

"use client";

import { useState, useEffect } from "react";
import { Icon, type IconName } from "@/components/ui/Icon";
import { KeyHint } from "@/components/ui/KeyHint";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { StatusChip } from "@/components/ui/StatusChip";
import { PriorityLabel } from "@/components/ui/PriorityLabel";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import { Tooltip } from "@/components/ui/Tooltip";

const ICON_NAMES: IconName[] = [
  "search",
  "filter",
  "board",
  "list",
  "plus",
  "calendar",
  "branch",
  "pr",
  "chevron-down",
  "chevron-right",
  "dots",
  "check",
  "edit",
  "clip",
  "box",
  "x",
  "arrow-right",
];

const STATUS_VALUES = ["open", "in-progress", "review", "done", "unknown-status"] as const;

const PRIORITY_VALUES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

const BADGE_TONES: BadgeTone[] = [
  "neutral",
  "primary",
  "status-open",
  "status-in-progress",
  "status-review",
  "status-done",
];

const BADGE_TONE_LABELS: Record<BadgeTone, string> = {
  neutral: "neutral",
  primary: "primary",
  "status-open": "status-open",
  "status-in-progress": "status-in-progress",
  "status-review": "status-review",
  "status-done": "status-done",
};

const VIEW_TABS: TabItem[] = [
  {
    value: "board",
    label: "Board",
    icon: <Icon name="board" size={14} />,
  },
  {
    value: "list",
    label: "List",
    icon: <Icon name="list" size={14} />,
  },
];

export default function UIGalleryPage() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [activeTab, setActiveTab] = useState("board");

  // Initialise theme from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem("agent-tasks:theme");
    if (stored === "light" || stored === "dark") {
      setTheme(stored);
      document.documentElement.setAttribute("data-theme", stored);
    }
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("agent-tasks:theme", next);
    document.documentElement.setAttribute("data-theme", next);
  }

  return (
    <div className="dev-gallery">
      {/* Fixed theme toggle */}
      <button className="dev-theme-toggle" onClick={toggleTheme} type="button">
        <Icon name="edit" size={12} />
        {theme === "dark" ? "Light mode" : "Dark mode"}
      </button>

      <h1 className="dev-gallery-title">Component library v2</h1>
      <p className="dev-gallery-subtitle">
        Stage B1 primitives: Icon, KeyHint, Badge, StatusChip, PriorityLabel, Tabs, Tooltip
      </p>

      {/* ── Status chips ──────────────────────────────────────── */}
      <section className="dev-section">
        <h2 className="dev-section-heading">StatusChip</h2>
        <div className="dev-row">
          {STATUS_VALUES.map((s) => (
            <StatusChip key={s} status={s} />
          ))}
        </div>
      </section>

      {/* ── Priority labels ───────────────────────────────────── */}
      <section className="dev-section">
        <h2 className="dev-section-heading">PriorityLabel</h2>
        <div className="dev-row">
          {PRIORITY_VALUES.map((p) => (
            <PriorityLabel key={p} priority={p} />
          ))}
        </div>
      </section>

      {/* ── Badges ────────────────────────────────────────────── */}
      <section className="dev-section">
        <h2 className="dev-section-heading">Badge</h2>
        <div className="dev-row">
          {BADGE_TONES.map((tone) => (
            <span
              key={tone}
              style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}
            >
              <Badge tone={tone}>5</Badge>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
                {BADGE_TONE_LABELS[tone]}
              </span>
            </span>
          ))}
        </div>
      </section>

      {/* ── Key hints ─────────────────────────────────────────── */}
      <section className="dev-section">
        <h2 className="dev-section-heading">KeyHint</h2>
        <div className="dev-row">
          <KeyHint>/</KeyHint>
          <KeyHint>C</KeyHint>
          <KeyHint>⌘</KeyHint>
          <KeyHint>↵</KeyHint>
          <KeyHint>⌘↵</KeyHint>
          <KeyHint>Esc</KeyHint>
        </div>
      </section>

      {/* ── Tabs ──────────────────────────────────────────────── */}
      <section className="dev-section">
        <h2 className="dev-section-heading">Tabs (segmented control)</h2>
        <div className="dev-row">
          <Tabs
            tabs={VIEW_TABS}
            value={activeTab}
            onChange={setActiveTab}
            label="View mode"
          />
          <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
            Active: {activeTab} (ArrowLeft/Right to navigate)
          </span>
        </div>
      </section>

      {/* ── Tooltip ───────────────────────────────────────────── */}
      <section className="dev-section">
        <h2 className="dev-section-heading">Tooltip</h2>
        <div className="dev-row">
          <Tooltip content="Opens in a new tab">
            <button
              type="button"
              style={{
                padding: "var(--space-2) var(--space-3)",
                background: "var(--surface-raised)",
                border: "1px solid var(--border-strong)",
                borderRadius: "var(--radius-base)",
                color: "var(--text)",
                fontSize: "var(--text-sm)",
                cursor: "pointer",
              }}
            >
              Hover or focus me
            </button>
          </Tooltip>
          <Tooltip content="Copy token to clipboard">
            <button
              type="button"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 32,
                height: 32,
                background: "transparent",
                border: "1px solid var(--border-strong)",
                borderRadius: "var(--radius-base)",
                color: "var(--muted)",
                cursor: "pointer",
              }}
            >
              <Icon name="clip" size={14} />
            </button>
          </Tooltip>
        </div>
      </section>

      {/* ── Icons ─────────────────────────────────────────────── */}
      <section className="dev-section">
        <h2 className="dev-section-heading">Icon (16px grid, all names)</h2>
        <div className="dev-icon-grid">
          {ICON_NAMES.map((name) => (
            <div key={name} className="dev-icon-cell">
              <Icon name={name} size={16} />
              <span className="dev-icon-cell-label">{name}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── Combined: key hint inside a button ────────────────── */}
      <section className="dev-section">
        <h2 className="dev-section-heading">KeyHint in context</h2>
        <div className="dev-row">
          {/* Search bar with key hint */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              width: 200,
              height: 28,
              padding: "0 6px 0 var(--space-2)",
              background: "var(--surface)",
              border: "1px solid var(--border-strong)",
              borderRadius: "var(--radius-base)",
              color: "var(--muted)",
              fontSize: "var(--text-sm)",
            }}
          >
            <Icon name="search" size={14} />
            <span style={{ flex: 1, fontSize: "12.5px" }}>Search tasks&hellip;</span>
            <KeyHint>/</KeyHint>
          </div>

          {/* Primary button with key hint */}
          <button
            type="button"
            className="btn-primary"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              height: 28,
              padding: "0 10px",
              borderRadius: "var(--radius-base)",
              fontSize: "12.5px",
              fontWeight: 500,
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            <Icon name="plus" size={13} />
            New task
            <KeyHint>C</KeyHint>
          </button>
        </div>
      </section>
    </div>
  );
}
