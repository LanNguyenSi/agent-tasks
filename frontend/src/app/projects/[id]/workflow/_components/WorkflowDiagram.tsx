"use client";

/**
 * WorkflowDiagram — read-only horizontal state-diagram strip.
 *
 * Shows workflow states as colored chips connected by arrow buttons.
 * Each arrow button represents a transition; arrows with gates carry a
 * small gate-count Badge. Clicking an arrow calls onArrowClick with the
 * transition's index so the parent can scroll to and highlight that row
 * in the transitions table.
 *
 * "Forward" transitions (from state[i] to state[i+1] in definition order)
 * appear as inline arrows between the state chips. All other transitions
 * (backward, skip, self-loops) are shown in a compact secondary row below.
 *
 * Pure CSS/flexbox — no canvas or SVG library.
 */

import { Fragment } from "react";
import type { WorkflowDefinition } from "../../../../../lib/api";
import { Badge } from "../../../../../components/ui/Badge";
import { Skeleton } from "../../../../../components/ui/Skeleton";

// CSS modifier class for known workflow state names (uses underscores).
const STATE_CLASS_MAP: Record<string, string> = {
  open: "",
  in_progress: "wf-state-node--in_progress",
  review: "wf-state-node--review",
  done: "wf-state-node--done",
};

function stateNodeClass(stateName: string, isInitial: boolean, isTerminal: boolean): string {
  const color = STATE_CLASS_MAP[stateName] ?? "";
  const initial = isInitial ? "wf-state-node--initial" : "";
  const terminal = isTerminal ? "wf-state-node--terminal" : "";
  return ["wf-state-node", color, initial, terminal].filter(Boolean).join(" ");
}

export interface WorkflowDiagramProps {
  def: WorkflowDefinition;
  /** Called when the user clicks a transition arrow; index is into def.transitions. */
  onArrowClick: (transitionIndex: number) => void;
  /** Loading state — renders a skeleton strip instead of the real diagram. */
  loading?: boolean;
}

/**
 * Skeleton placeholder for the strip while data loads.
 */
export function WorkflowDiagramSkeleton() {
  return (
    <div className="wf-strip">
      <div className="wf-skeleton-strip" role="status" aria-busy="true">
        <span className="sr-only">Loading workflow diagram</span>
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} width={90} height={26} radius="var(--radius-base)" />
        ))}
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={`a-${i}`} width={24} height={16} radius="var(--radius-sm)" />
        ))}
      </div>
    </div>
  );
}

export function WorkflowDiagram({ def, onArrowClick, loading }: WorkflowDiagramProps) {
  if (loading) {
    return <WorkflowDiagramSkeleton />;
  }

  const stateNames = def.states.map((s) => s.name);

  // Build index from state name → position in definition order.
  const statePos = new Map<string, number>(stateNames.map((n, i) => [n, i]));

  // Partition transitions into:
  // - forward[i→i+1]: transitions from state[i] to state[i+1] (adjacent)
  // - other: everything else (backward, skip-steps, self-loops)
  const forwardMap = new Map<string, Array<{ index: number; gateCount: number }>>();
  const otherTransitions: Array<{ index: number; from: string; to: string; gateCount: number }> = [];

  def.transitions.forEach((t, idx) => {
    const fromPos = statePos.get(t.from) ?? -1;
    const toPos = statePos.get(t.to) ?? -1;
    const gateCount = t.requires?.length ?? 0;

    if (fromPos !== -1 && toPos !== -1 && toPos === fromPos + 1) {
      const key = `${fromPos}-${toPos}`;
      if (!forwardMap.has(key)) forwardMap.set(key, []);
      forwardMap.get(key)!.push({ index: idx, gateCount });
    } else {
      otherTransitions.push({ index: idx, from: t.from, to: t.to, gateCount });
    }
  });

  return (
    <div className="wf-strip">
      <p className="wf-strip-heading">State flow</p>
      {/* Primary row: states + adjacent arrows */}
      <div className="wf-strip-row">
        {def.states.map((s, i) => {
          const isInitial = s.name === def.initialState;
          const arrows = forwardMap.get(`${i}-${i + 1}`) ?? null;
          const hasNextState = i < def.states.length - 1;

          return (
            <Fragment key={s.name}>
              {/* State chip */}
              <span
                className={stateNodeClass(s.name, isInitial, s.terminal)}
                title={isInitial ? `Initial state: ${s.label}` : s.label}
              >
                {s.label}
              </span>

              {/* Arrow(s) to the next state */}
              {hasNextState && (
                arrows && arrows.length > 0 ? (
                  arrows.map(({ index, gateCount }) => (
                    <button
                      key={index}
                      type="button"
                      className="wf-arrow-btn"
                      onClick={() => onArrowClick(index)}
                      title={`Go to transition ${def.transitions[index]!.from} → ${def.transitions[index]!.to}${gateCount > 0 ? ` (${gateCount} gate${gateCount !== 1 ? "s" : ""})` : ""}`}
                      aria-label={`Transition ${def.transitions[index]!.from} to ${def.transitions[index]!.to}${gateCount > 0 ? `, ${gateCount} gate${gateCount !== 1 ? "s" : ""}` : ""}`}
                    >
                      <span aria-hidden="true">→</span>
                      {gateCount > 0 && (
                        <Badge tone="primary">{gateCount}</Badge>
                      )}
                    </button>
                  ))
                ) : (
                  <span className="wf-arrow-static" aria-hidden="true">·</span>
                )
              )}
            </Fragment>
          );
        })}
      </div>

      {/* Secondary row: non-adjacent / backward / skip transitions */}
      {otherTransitions.length > 0 && (
        <div className="wf-skip-row" aria-label="Additional transitions">
          {otherTransitions.map(({ index, from, to, gateCount }) => (
            <button
              key={index}
              type="button"
              className="wf-skip-arrow"
              onClick={() => onArrowClick(index)}
              title={`${from} → ${to}${gateCount > 0 ? ` (${gateCount} gate${gateCount !== 1 ? "s" : ""})` : ""}`}
            >
              <span>{from}</span>
              <span aria-hidden="true">→</span>
              <span>{to}</span>
              {gateCount > 0 && (
                <Badge tone="primary">{gateCount}</Badge>
              )}
            </button>
          ))}
        </div>
      )}

      {def.states.length === 0 && (
        <p className="wf-table-hint">No states defined.</p>
      )}
    </div>
  );
}
