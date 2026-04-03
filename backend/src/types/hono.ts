import type { Actor } from "./auth.js";

/** Typed Hono context variables — used across all routes */
export type AppVariables = {
  actor: Actor;
};
