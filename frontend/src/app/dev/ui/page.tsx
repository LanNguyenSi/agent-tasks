// Component library v2 gallery — B1 + B2 primitives in every state.
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
import { Table, type ColumnDef } from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import Select from "@/components/ui/Select";
import Modal from "@/components/ui/Modal";

// ── Icon names ───────────────────────────────────────────────────

const ICON_NAMES: IconName[] = [
  "search", "filter", "board", "list", "plus", "calendar",
  "branch", "pr", "chevron-down", "chevron-right", "dots",
  "check", "edit", "clip", "box", "x", "arrow-right",
];

// ── B1 data ──────────────────────────────────────────────────────

const STATUS_VALUES = ["open", "in-progress", "review", "done", "unknown-status"] as const;
const PRIORITY_VALUES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
const BADGE_TONES: BadgeTone[] = [
  "neutral", "primary",
  "status-open", "status-in-progress", "status-review", "status-done",
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
  { value: "board", label: "Board", icon: <Icon name="board" size={14} /> },
  { value: "list",  label: "List",  icon: <Icon name="list"  size={14} /> },
];

// ── Table demo data ──────────────────────────────────────────────

interface DemoRow extends Record<string, unknown> {
  id: string;
  title: string;
  status: string;
  priority: string;
  assignee: string;
  updated: string;
}

const TABLE_ROWS: DemoRow[] = [
  { id: "1", title: "Implement auth gateway",     status: "in-progress", priority: "HIGH",     assignee: "alice",  updated: "2h ago" },
  { id: "2", title: "Fix pagination overflow",    status: "open",        priority: "MEDIUM",   assignee: "bob",    updated: "1d ago" },
  { id: "3", title: "Write migration guide",      status: "review",      priority: "LOW",      assignee: "carol",  updated: "3d ago" },
  { id: "4", title: "Upgrade CI runner images",   status: "done",        priority: "MEDIUM",   assignee: "alice",  updated: "5d ago" },
  { id: "5", title: "Add webhook signature check",status: "open",        priority: "CRITICAL", assignee: "david",  updated: "12h ago" },
];

const TABLE_COLS: ColumnDef<DemoRow>[] = [
  { key: "title",    header: "Title",    sortable: true, render: (r) => r.title },
  { key: "status",   header: "Status",   render: (r) => <StatusChip status={r.status} /> },
  { key: "priority", header: "Priority", sortable: true, render: (r) => <PriorityLabel priority={r.priority as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"} /> },
  { key: "assignee", header: "Assignee", render: (r) => <span style={{ color: "var(--text-secondary)", fontSize: "var(--text-xs)" }}>{r.assignee}</span> },
  { key: "updated",  header: "Updated",  render: (r) => <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>{r.updated}</span> },
];

// ── Select options ───────────────────────────────────────────────

const SELECT_OPTIONS = [
  { value: "all",       label: "All projects" },
  { value: "agent-tasks", label: "agent-tasks" },
  { value: "harness",   label: "harness" },
  { value: "telerithm", label: "telerithm" },
];

// ── Long lorem for modal scroll test ─────────────────────────────

const LONG_BODY = Array.from({ length: 6 }, (_, i) =>
  `Paragraph ${i + 1}: Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.`
).join("\n\n");

// ── Page component ───────────────────────────────────────────────

export default function UIGalleryPage() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [activeTab, setActiveTab] = useState("board");
  const [selectVal, setSelectVal] = useState("all");
  const [modalOpen, setModalOpen] = useState(false);
  const { toast } = useToast();

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
        Stage B1 + B2: Table, Toast, PageHeader, Button, Card, EmptyState, Select, Modal + upgraded primitives
      </p>

      {/* ── B2: PageHeader ────────────────────────────────────── */}
      <section className="dev-section">
        <h2 className="dev-section-heading">PageHeader (inline demo — sticky in real pages)</h2>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}>
          <PageHeader
            breadcrumb={<><a href="#">Home</a> / Projects / agent-tasks</>}
            title="agent-tasks"
            summary="12 open"
          >
            <Button variant="ghost" size="sm">
              <Icon name="filter" size={14} />
              Filter
            </Button>
            <Button variant="primary" size="sm" keyHint="C">
              <Icon name="plus" size={14} />
              New task
            </Button>
          </PageHeader>
        </div>
      </section>

      {/* ── B2: Table ─────────────────────────────────────────── */}
      <section className="dev-section">
        <h2 className="dev-section-heading">Table (sortable, row links, stacked under 900px)</h2>
        <Table
          columns={TABLE_COLS}
          rows={TABLE_ROWS}
          rowKey={(r) => r.id}
          rowHref={(r) => `/tasks/${r.id}`}
        />
        <p style={{ marginTop: "var(--space-2)", fontSize: "var(--text-xs)", color: "var(--muted)" }}>
          Resize below 900px to see stacked two-line card mode. Click title cell link or row to navigate.
        </p>
        <div style={{ marginTop: "var(--space-4)", display: "flex", gap: "var(--space-4)", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 300px" }}>
            <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "var(--space-2)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Empty state</p>
            <Table columns={TABLE_COLS} rows={[]} rowKey={(r) => r.id} emptyLabel="No tasks match your filters." />
          </div>
          <div style={{ flex: "1 1 300px" }}>
            <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "var(--space-2)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Loading state</p>
            <Table columns={TABLE_COLS} rows={[]} rowKey={(r) => r.id} loading />
          </div>
        </div>
      </section>

      {/* ── B2: Toast ─────────────────────────────────────────── */}
      <section className="dev-section">
        <h2 className="dev-section-heading">Toast (portal, auto-dismiss 5s, pause-on-hover)</h2>
        <div className="dev-row">
          <Button variant="secondary" size="sm" onClick={() => toast("Task saved successfully.", "success")}>
            Success toast
          </Button>
          <Button variant="secondary" size="sm" onClick={() => toast("Failed to connect. Please retry.", "error")}>
            Error toast
          </Button>
          <Button variant="secondary" size="sm" onClick={() => toast("Workflow updated. Changes take effect on next run.", "info")}>
            Info toast
          </Button>
        </div>
      </section>

      {/* ── B2: Button matrix ─────────────────────────────────── */}
      <section className="dev-section">
        <h2 className="dev-section-heading">Button (variants x sizes x loading / disabled / href / keyHint)</h2>

        <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "var(--space-2)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
          Variants (md)
        </p>
        <div className="dev-row" style={{ marginBottom: "var(--space-4)" }}>
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="outline-danger">Outline danger</Button>
          <Button variant="link">Link</Button>
          <Button variant="link-danger">Link danger</Button>
        </div>

        <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "var(--space-2)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
          Sizes (primary)
        </p>
        <div className="dev-row" style={{ marginBottom: "var(--space-4)" }}>
          <Button variant="primary" size="sm">Small</Button>
          <Button variant="primary" size="md">Medium</Button>
          <Button variant="primary" size="lg">Large</Button>
        </div>

        <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "var(--space-2)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
          States
        </p>
        <div className="dev-row" style={{ marginBottom: "var(--space-4)" }}>
          <Button variant="primary" loading>Loading</Button>
          <Button variant="secondary" loading>Loading</Button>
          <Button variant="primary" disabled>Disabled</Button>
          <Button variant="secondary" disabled>Disabled</Button>
        </div>

        <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "var(--space-2)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
          href + keyHint
        </p>
        <div className="dev-row">
          <Button variant="primary" href="#" keyHint="C" size="sm">
            <Icon name="plus" size={13} />
            New task
          </Button>
          <Button variant="secondary" href="#" size="sm">
            Open link
            <Icon name="arrow-right" size={13} />
          </Button>
          <Button variant="ghost" size="sm" keyHint="/">
            <Icon name="search" size={13} />
            Search
          </Button>
        </div>
      </section>

      {/* ── B2: Card surfaces ─────────────────────────────────── */}
      <section className="dev-section">
        <h2 className="dev-section-heading">Card (surface vs raised, dashed, interactive)</h2>
        <div className="dev-row" style={{ alignItems: "stretch" }}>
          <Card surface="surface" style={{ minWidth: 160 }}>
            <p style={{ fontSize: "var(--text-sm)", fontWeight: 600 }}>surface</p>
            <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>--surface bg</p>
          </Card>
          <Card surface="raised" style={{ minWidth: 160 }}>
            <p style={{ fontSize: "var(--text-sm)", fontWeight: 600 }}>raised</p>
            <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>--surface-raised bg</p>
          </Card>
          <Card surface="raised" dashed style={{ minWidth: 160 }}>
            <p style={{ fontSize: "var(--text-sm)", fontWeight: 600 }}>raised + dashed</p>
            <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>transparent bg</p>
          </Card>
          <Card surface="surface" interactive style={{ minWidth: 160 }}>
            <p style={{ fontSize: "var(--text-sm)", fontWeight: 600 }}>interactive</p>
            <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>hover to see lift</p>
          </Card>
        </div>
      </section>

      {/* ── B2: Select ────────────────────────────────────────── */}
      <section className="dev-section">
        <h2 className="dev-section-heading">Select (28px trigger, portal, flip-positioning)</h2>
        <div className="dev-row" style={{ alignItems: "flex-start" }}>
          <Select
            options={SELECT_OPTIONS}
            value={selectVal}
            onChange={setSelectVal}
            style={{ width: 200 }}
          />
          <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)", alignSelf: "center" }}>
            Selected: <code style={{ fontFamily: "var(--font-mono)" }}>{selectVal}</code>
          </span>
        </div>
      </section>

      {/* ── B2: Modal ─────────────────────────────────────────── */}
      <section className="dev-section">
        <h2 className="dev-section-heading">Modal (long body proves pinned footer, header/body/footer slots)</h2>
        <div className="dev-row">
          <Button variant="secondary" size="sm" onClick={() => setModalOpen(true)}>
            Open modal
          </Button>
        </div>
        <Modal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          title="Scroll test — pinned footer"
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setModalOpen(false)}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={() => { toast("Saved!", "success"); setModalOpen(false); }}>
                Save changes
              </Button>
            </>
          }
        >
          <div style={{ whiteSpace: "pre-line", fontSize: "var(--text-sm)", lineHeight: 1.7, color: "var(--text-secondary)" }}>
            {LONG_BODY}
          </div>
        </Modal>
      </section>

      {/* ── B2: EmptyState ────────────────────────────────────── */}
      <section className="dev-section">
        <h2 className="dev-section-heading">EmptyState (icon, title, description, dashed, action)</h2>
        <div className="dev-row" style={{ alignItems: "stretch", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 220px" }}>
            <EmptyState
              icon="box"
              title="No tasks yet"
              description="Create your first task to get started."
              action={<Button variant="primary" size="sm">New task</Button>}
            />
          </div>
          <div style={{ flex: "1 1 220px" }}>
            <EmptyState
              icon="filter"
              title="No results"
              description="Try adjusting your filters."
              dashed
              action={<Button variant="ghost" size="sm">Clear filters</Button>}
            />
          </div>
          <div style={{ flex: "1 1 220px" }}>
            <EmptyState message="Legacy message prop still works." dashed />
          </div>
        </div>
      </section>

      {/* ── B1: StatusChip ────────────────────────────────────── */}
      <section className="dev-section">
        <h2 className="dev-section-heading">StatusChip</h2>
        <div className="dev-row">
          {STATUS_VALUES.map((s) => (
            <StatusChip key={s} status={s} />
          ))}
        </div>
      </section>

      {/* ── B1: PriorityLabel ─────────────────────────────────── */}
      <section className="dev-section">
        <h2 className="dev-section-heading">PriorityLabel</h2>
        <div className="dev-row">
          {PRIORITY_VALUES.map((p) => (
            <PriorityLabel key={p} priority={p} />
          ))}
        </div>
      </section>

      {/* ── B1: Badges ────────────────────────────────────────── */}
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

      {/* ── B1: KeyHint ───────────────────────────────────────── */}
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

      {/* ── B1: Tabs ──────────────────────────────────────────── */}
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

      {/* ── B1: Tooltip ───────────────────────────────────────── */}
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

      {/* ── B1: Icons ─────────────────────────────────────────── */}
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

      {/* ── B1: KeyHint in context ────────────────────────────── */}
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

          {/* Primary button with key hint — uses the Button component */}
          <Button variant="primary" size="sm" keyHint="C">
            <Icon name="plus" size={13} />
            New task
          </Button>
        </div>
      </section>
    </div>
  );
}
