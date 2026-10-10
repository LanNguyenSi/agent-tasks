"use client";

// Admin-only control to hand a work or review claim to another eligible actor
// (POST /tasks/:id/admin-reassign). Rendered by TaskMetaSidebar next to the
// admin release control, and only for a human project admin: the backend
// refuses agents and non-admins with 403, so the picker is not offered to them
// at all. The candidate list is fetched when the picker opens, not on every
// task view.

import { useState } from "react";
import {
  adminReassignClaim,
  getEligibleActors,
  type ClaimHolder,
  type EligibleActors,
  type Task,
} from "@/lib/api";
import { Button } from "@/components/ui/Button";
import Select from "@/components/ui/Select";

interface ClaimReassignPickerProps {
  taskId: string;
  projectId: string;
  claim: "work" | "review";
  /** Who holds this claim now; left out of the options (the backend 409s a
   * hand-off to the current holder). */
  currentHolder: ClaimHolder | null;
  onReassigned: (task: Task) => void;
}

function encode(holder: ClaimHolder): string {
  return `${holder.type}:${holder.id}`;
}

function decode(value: string): ClaimHolder | null {
  const sep = value.indexOf(":");
  if (sep < 0) return null;
  const type = value.slice(0, sep);
  if (type !== "human" && type !== "agent") return null;
  return { type, id: value.slice(sep + 1) };
}

function buildOptions(actors: EligibleActors, currentHolder: ClaimHolder | null) {
  const isCurrent = (holder: ClaimHolder) =>
    currentHolder !== null && currentHolder.type === holder.type && currentHolder.id === holder.id;
  return [
    ...actors.humans
      .filter((h) => !isCurrent({ type: "human", id: h.userId }))
      .map((h) => ({ value: encode({ type: "human", id: h.userId }), label: `${h.name} (${h.source === "team" ? "team member" : "project member"})` })),
    ...actors.agents
      .filter((a) => !isCurrent({ type: "agent", id: a.tokenId }))
      .map((a) => ({ value: encode({ type: "agent", id: a.tokenId }), label: `Agent ${a.name}` })),
  ];
}

export default function ClaimReassignPicker({
  taskId,
  projectId,
  claim,
  currentHolder,
  onReassigned,
}: ClaimReassignPickerProps) {
  const [open, setOpen] = useState(false);
  const [actors, setActors] = useState<EligibleActors | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const claimLabel = claim === "review" ? "review" : "work";

  function describe(err: unknown, fallback: string): string {
    return err instanceof Error ? err.message : fallback;
  }

  async function openPicker() {
    setOpen(true);
    setError(null);
    setSelected("");
    setLoading(true);
    try {
      setActors(await getEligibleActors(projectId));
    } catch (err) {
      setActors(null);
      setError(describe(err, "Could not load eligible actors"));
    } finally {
      setLoading(false);
    }
  }

  function closePicker() {
    if (busy) return;
    setOpen(false);
    setError(null);
  }

  async function submit() {
    const target = decode(selected);
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const { task } = await adminReassignClaim(taskId, { claim, target });
      setOpen(false);
      onReassigned(task);
    } catch (err) {
      setError(describe(err, "Could not reassign the claim"));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void openPicker()}
        title={`Hand this ${claimLabel} claim to another eligible actor`}
      >
        Reassign
      </Button>
    );
  }

  const options = actors ? buildOptions(actors, currentHolder) : [];

  return (
    <span className="td-reassign">
      {loading ? (
        <span className="td-reassign-hint">Loading eligible actors…</span>
      ) : actors ? (
        <>
          <Select
            value={selected}
            onChange={setSelected}
            options={options}
            placeholder={`Reassign ${claimLabel} claim to…`}
            ariaLabel={`Reassign ${claimLabel} claim to`}
            className="td-reassign-select"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!selected || busy}
            loading={busy}
            onClick={() => void submit()}
          >
            Assign
          </Button>
        </>
      ) : null}
      <Button variant="ghost" size="sm" onClick={closePicker} disabled={busy}>
        Cancel
      </Button>
      {error && (
        <span className="td-reassign-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
