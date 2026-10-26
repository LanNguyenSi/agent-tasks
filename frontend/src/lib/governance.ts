/**
 * Governance mode names shown to people. The project header chip and the
 * project settings option cards both read this map, so a mode carries one
 * label everywhere.
 */
export type GovernanceMode =
  | "REQUIRES_DISTINCT_REVIEWER"
  | "AWAITS_CONFIRMATION"
  | "AUTONOMOUS";

export const GOVERNANCE_LABELS: Record<GovernanceMode, string> = {
  REQUIRES_DISTINCT_REVIEWER: "Second reviewer",
  AWAITS_CONFIRMATION: "Human confirmation",
  AUTONOMOUS: "Autonomous",
};
