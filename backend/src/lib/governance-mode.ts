/**
 * Governance-mode derivation helpers.
 *
 * The `governanceMode` enum collapses the legacy two-flag encoding
 * (`soloMode`, `requireDistinctReviewer`) into a single three-valued enum:
 *
 *   - `REQUIRES_DISTINCT_REVIEWER` — dual-control. Claimant cannot merge.
 *   - `AWAITS_CONFIRMATION`        — async HITL. Self-merge OK, humans notified.
 *   - `AUTONOMOUS`                 — single-actor project. No gates, no notices.
 *
 * Existing rows may have `governanceMode: null` until they're next written.
 * `resolveGovernanceMode` reads the new column when set and falls back to a
 * deterministic derivation from the legacy flags when it's null. Call-sites
 * should use this helper instead of reading the legacy flags directly so the
 * deprecation can happen as a single file change when we're ready to drop
 * them.
 */
export enum GovernanceMode {
  REQUIRES_DISTINCT_REVIEWER = "REQUIRES_DISTINCT_REVIEWER",
  AWAITS_CONFIRMATION = "AWAITS_CONFIRMATION",
  AUTONOMOUS = "AUTONOMOUS",
}

export interface GovernanceFlagsLike {
  governanceMode?: GovernanceMode | string | null;
  soloMode?: boolean | null;
  requireDistinctReviewer?: boolean | null;
}

/**
 * Pure function: derive the governance mode from the legacy flag pair.
 *
 * Policy:
 *   - `soloMode=true` wins: it's a positive declaration of a single-actor
 *     workflow, and the `requireDistinctReviewer=true + soloMode=true` combo
 *     was always a no-op because the gate bypassed on soloMode.
 *   - Otherwise `requireDistinctReviewer=true` → dual-control.
 *   - Otherwise → async HITL.
 */
export function deriveGovernanceModeFromFlags(flags: {
  soloMode: boolean;
  requireDistinctReviewer: boolean;
}): GovernanceMode {
  if (flags.soloMode) return GovernanceMode.AUTONOMOUS;
  if (flags.requireDistinctReviewer) return GovernanceMode.REQUIRES_DISTINCT_REVIEWER;
  return GovernanceMode.AWAITS_CONFIRMATION;
}

/**
 * Read the current governance mode for a project-shaped input, preferring
 * the explicit column and falling back to the legacy flags. Accepts a broad
 * shape so every route / service can pass whatever slice of `Project` it
 * already has in scope.
 */
export function resolveGovernanceMode(project: GovernanceFlagsLike): GovernanceMode {
  if (project.governanceMode) {
    const value = project.governanceMode as string;
    if (value in GovernanceMode) return GovernanceMode[value as keyof typeof GovernanceMode];
    // Defensive: unknown value in DB. Fall through to the legacy derivation
    // rather than throw — the runtime stays self-healing.
  }
  return deriveGovernanceModeFromFlags({
    soloMode: Boolean(project.soloMode),
    requireDistinctReviewer: Boolean(project.requireDistinctReviewer),
  });
}

/**
 * Inverse of `deriveGovernanceModeFromFlags`: given a governance mode, what
 * do the legacy flags need to be? Used by the PATCH endpoint to keep the
 * legacy columns in sync when a client writes via the new enum, so clients
 * still reading the old fields don't see stale values.
 */
export function legacyFlagsFromGovernanceMode(mode: GovernanceMode): {
  soloMode: boolean;
  requireDistinctReviewer: boolean;
} {
  switch (mode) {
    case GovernanceMode.AUTONOMOUS:
      return { soloMode: true, requireDistinctReviewer: false };
    case GovernanceMode.REQUIRES_DISTINCT_REVIEWER:
      return { soloMode: false, requireDistinctReviewer: true };
    case GovernanceMode.AWAITS_CONFIRMATION:
      return { soloMode: false, requireDistinctReviewer: false };
  }
}

/** Convenience flags derived from the resolved mode — saves boilerplate. */
export function governanceFlags(mode: GovernanceMode): {
  allowsSelfMerge: boolean;
  requiresDistinctReviewer: boolean;
  emitsSelfMergeNotice: boolean;
} {
  return {
    allowsSelfMerge:
      mode === GovernanceMode.AUTONOMOUS ||
      mode === GovernanceMode.AWAITS_CONFIRMATION,
    requiresDistinctReviewer: mode === GovernanceMode.REQUIRES_DISTINCT_REVIEWER,
    emitsSelfMergeNotice: mode === GovernanceMode.AWAITS_CONFIRMATION,
  };
}
