/**
 * Registry wrapper for the pre-existing self-merge gate.
 *
 * See `distinct-reviewer.ts` for the pattern: enforcement lives in
 * `services/review-gate.ts`, this file adds registry metadata only.
 */
import {
  GovernanceMode,
  resolveGovernanceMode,
} from "../../lib/governance-mode.js";
import {
  checkSelfMergeGate,
  selfMergeRejectionMessage,
} from "../review-gate.js";
import type { Gate } from "./types.js";
import { GateCode } from "./types.js";

export { checkSelfMergeGate, selfMergeRejectionMessage };

export const selfMergeGate: Gate = {
  code: GateCode.SelfMerge,
  name: "Work-claimant cannot merge their own PR",
  appliesTo: ["pull_requests_merge", "task_merge", "task_finish"],
  describe(project) {
    const mode = resolveGovernanceMode(project);
    if (mode === GovernanceMode.REQUIRES_DISTINCT_REVIEWER) {
      return {
        active: true,
        because:
          "governanceMode=REQUIRES_DISTINCT_REVIEWER; the agent or human who holds the work claim cannot be the one invoking merge.",
      };
    }
    return {
      active: false,
      because:
        mode === GovernanceMode.AUTONOMOUS
          ? "governanceMode=AUTONOMOUS — single-actor project, self-merge permitted by design."
          : "governanceMode=AWAITS_CONFIRMATION — self-merge permitted, notice emitted out-of-band instead.",
    };
  },
};
