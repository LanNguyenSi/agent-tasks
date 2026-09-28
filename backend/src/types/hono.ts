import type { Actor } from "./auth.js";
import type { GroundingRemoteTargetGuard } from "../services/grounding-scope.js";

/** Typed Hono context variables — used across all routes */
export type AppVariables = {
  actor: Actor;
  /** Set by createApp for every request: the enabled runtime's effect-boundary
   * guard, or null in the unconfigured application. See groundingRemoteGuardFor. */
  groundingRemoteTargetGuard?: GroundingRemoteTargetGuard | null;
};
