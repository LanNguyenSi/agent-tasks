/**
 * Gate-registry types.
 *
 * A "gate" is a named invariant that the backend checks before executing
 * side-effects or state transitions. Historically gates were inline `if
 * (…) return 403` blocks scattered across route handlers, and callers only
 * learned about them by tripping a 4xx. The registry (see
 * `./index.ts`) consolidates their identity + per-project activeness so
 * callers can introspect which gates apply to a project BEFORE making the
 * call.
 *
 * v1 scope: four gates inventoried. Enforcement call-sites still live in
 * the route handlers for now; the registry is the discovery surface, not a
 * central dispatcher. Follow-up iterations can migrate enforcement to flow
 * through the same function objects registered here.
 */
import type { GovernanceFlagsLike } from "../../lib/governance-mode.js";

/**
 * Project slice a gate may inspect during `describe()`. Widens
 * `GovernanceFlagsLike` with the one other field the current inventory
 * needs (`githubRepo` for the cross-repo gate). Gates should only read
 * the fields they actually care about so future additions don't force
 * every call-site to widen its Prisma select.
 */
export interface GateProjectContext extends GovernanceFlagsLike {
  githubRepo?: string | null;
}

/**
 * Stable identifiers. The wire format uses the string value — treat these
 * as part of the public API. Renaming requires a deprecation cycle.
 */
export enum GateCode {
  DistinctReviewer = "distinct_reviewer",
  SelfMerge = "self_merge",
  TaskStatusForMerge = "task_status_for_merge",
  PrRepoMatchesProject = "pr_repo_matches_project",
}

/**
 * Per-project projection of a gate: does it evaluate at all on this
 * project, and why? `active=false` does NOT mean the gate is gone — it
 * means the gate is registered in the codebase but will short-circuit to
 * `allowed` for any call on this specific project (typical for governance
 * gates that bypass on soloMode).
 */
export interface EffectiveGate {
  code: GateCode;
  name: string;
  active: boolean;
  because: string;
  /**
   * Verb names (stdio MCP + HTTP bridge) that can trip this gate. Freetext
   * at this layer — the source of truth is the verb that actually invokes
   * the check. Kept here so `effectiveGates` is self-describing without
   * clients having to cross-reference the verb surface.
   */
  appliesTo: readonly string[];
}

export interface Gate {
  code: GateCode;
  name: string;
  appliesTo: readonly string[];
  /**
   * Pure function: given a project's governance + repo config, return
   * whether this gate would evaluate, and the human-readable reason. No
   * I/O, no Prisma — this is introspection, not enforcement.
   */
  describe(project: GateProjectContext): { active: boolean; because: string };
}
