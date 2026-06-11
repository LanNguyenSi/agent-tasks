"use client";

// Project picker: renders as the PageHeader H1 (a button with chevron that
// opens a DropdownMenu of projects). The current project name is displayed
// inline; the Settings / Members / Workflow links are exposed in the
// companion overflow DropdownMenu rendered by the parent.
//
// Geometry in .db-proj-switch and related classes in globals.css.

import { useRef, useState } from "react";
import DropdownMenu from "../ui/DropdownMenu";
import { Icon } from "../ui/Icon";

export interface ProjectOption {
  id: string;
  name: string;
  accessSource?: "team" | "project";
}

interface ProjectPickerProps {
  projects: ProjectOption[];
  selectedProjectId: string;
  onSelect: (id: string) => void;
  loading?: boolean;
}

function ShareIcon({ label }: { label?: string }) {
  return (
    <span
      className="db-share-icon"
      role="img"
      aria-label={label ?? "Shared via project invite"}
      title={label ?? "Shared via project invite"}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="3.5" cy="8" r="2" />
        <circle cx="12" cy="3.5" r="2" />
        <circle cx="12" cy="12.5" r="2" />
        <path d="M5.2 7.1l5.2-2.5M5.2 8.9l5.2 2.5" />
      </svg>
    </span>
  );
}

export default function ProjectPicker({
  projects,
  selectedProjectId,
  onSelect,
  loading = false,
}: ProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const disabled = loading || projects.length === 0;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="db-proj-switch"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Switch project, current: ${selectedProject?.name ?? "none"}`}
      >
        {selectedProject?.accessSource === "project" && (
          <ShareIcon label={`${selectedProject.name} (shared via project invite)`} />
        )}
        <span className="db-proj-switch-name">
          {selectedProject?.name ?? (loading ? "Loading…" : "Select project")}
        </span>
        <span className="db-proj-switch-chevron">
          <Icon name="chevron-down" size={13} />
        </span>
      </button>

      <DropdownMenu
        anchorRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        align="start"
        minWidth={220}
        className="project-picker-menu"
      >
        <div role="menu" className="menu-scroll">
          {projects.map((project) => {
            const active = project.id === selectedProjectId;
            return (
              <button
                key={project.id}
                type="button"
                role="menuitem"
                className={`menu-option${active ? " menu-option-active" : ""}`}
                onClick={() => {
                  setOpen(false);
                  if (project.id !== selectedProjectId) onSelect(project.id);
                }}
                title={
                  project.accessSource === "project"
                    ? `${project.name} (shared)`
                    : project.name
                }
              >
                {project.accessSource === "project" && (
                  <ShareIcon label={`${project.name} (shared via project invite)`} />
                )}
                {project.name}
              </button>
            );
          })}
        </div>
      </DropdownMenu>
    </>
  );
}
