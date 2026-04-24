/**
 * Registry wrapper for the pre-existing distinct-reviewer gate.
 *
 * The enforcement function `checkDistinctReviewerGate` already lives in
 * `services/review-gate.ts` and is called directly by transition-like
 * handlers. This file ONLY adds the registry-facing metadata (code,
 * appliesTo, per-project `describe()`) so the gate shows up in
 * `effectiveGates`. Re-exports the enforcement function for convenience
 * so gate consumers can import enforcement + metadata from one module.
 */
import {
  GovernanceMode,
  resolveGovernanceMode,
} from "../../lib/governance-mode.js";
import {
  checkDistinctReviewerGate,
  distinctReviewerRejectionMessage,
} from "../review-gate.js";
import type { Gate } from "./types.js";
import { GateCode } from "./types.js";

export { checkDistinctReviewerGate, distinctReviewerRejectionMessage };

export const distinctReviewerGate: Gate = {
  code: GateCode.DistinctReviewer,
  name: "Distinct reviewer required for review→done",
  appliesTo: ["task_finish", "tasks_transition"],
  describe(project) {
    const mode = resolveGovernanceMode(project);
    if (mode === GovernanceMode.REQUIRES_DISTINCT_REVIEWER) {
      return {
        active: true,
        because:
          "governanceMode=REQUIRES_DISTINCT_REVIEWER; the work-claimant cannot approve their own task (a different actor must hold the review lock).",
      };
    }
    if (mode === GovernanceMode.AUTONOMOUS) {
      return {
        active: false,
        because:
          "governanceMode=AUTONOMOUS (legacy soloMode=true) — single-actor project, no distinct reviewer needed.",
      };
    }
    return {
      active: false,
      because:
        "governanceMode=AWAITS_CONFIRMATION — async HITL, self-approval permitted, notification fires out-of-band.",
    };
  },
};
