import type { Actor } from "./auth.js";
import type { GroundingRemoteTargetGuard } from "../services/grounding-scope.js";
import type { MergeReservation } from "../services/task-merge-reservation.js";

/** Typed Hono context variables — used across all routes */
export type AppVariables = {
  actor: Actor;
  /** Set by createApp for every request: the enabled runtime's effect-boundary
   * guard, or null in the unconfigured application. See groundingRemoteGuardFor. */
  groundingRemoteTargetGuard?: GroundingRemoteTargetGuard | null;
  /** The merge reservation the current request holds, released when the
   * request ends (see taskRouter's reservation release middleware). */
  mergeReservation?: { taskId: string; reservation: MergeReservation } | null;
};
