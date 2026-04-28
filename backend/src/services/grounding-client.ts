// Grounding client. Wraps `@lannguyensi/grounding-wrapper` so the
// pickup/start endpoints can auto-initialize a grounding session for
// debug-flavored tasks (Phase 2 of the grounding-hint integration).
//
// Failure semantics: every failure mode (disabled flag, missing module,
// synchronous throw inside the wrapper) collapses to `start() => null`. The
// route handlers fall back to the Phase 1 advisory hint in that case, so a
// broken or missing wrapper never blocks task pickup.
//
// The full session JSON returned by `initSession` is persisted on the task's
// metadata so a future Phase 2.5 cross-host import tool in `grounding-mcp`
// can rehydrate the session on the agent's side.

import { createRequire } from "node:module";
import { logger } from "../lib/logger.js";

// Bridge to CommonJS-style require so the wrapper module can be loaded
// synchronously inside the (sync) factory below. The wrapper is ESM-safe
// either way; using createRequire keeps the load failure recoverable
// without forcing the factory to become async.
const requireFromHere = createRequire(import.meta.url);

export interface GroundingStartInput {
  keyword: string;
  problem: string;
  // Optional correlation context. Passed through to the warn log on
  // wrapper failure so a consistently-broken wrapper in production
  // produces actionable lines instead of an opaque "initSession failed".
  taskId?: string;
  projectSlug?: string;
}

export interface GroundingStartResult {
  sessionId: string;
  currentPhase: string;
  mandatorySequence: string[];
  activeGuardrails: string[];
  // Full session JSON, persisted on the task so a future Phase 2.5
  // (cross-host import tool in grounding-mcp) can rehydrate it on the
  // agent's side.
  sessionState: unknown;
}

export interface GroundingClient {
  start(input: GroundingStartInput): Promise<GroundingStartResult | null>;
}

// Minimal shape we rely on from the wrapper. Kept separate from the wrapper's
// own type so a partial / mocked session shape doesn't break the mapping
// (callers who depend on extra fields can read them off `sessionState`).
interface WrapperSessionShape {
  id: string;
  current_phase: string;
  mandatory_sequence: string[];
  active_guardrails: string[];
  [key: string]: unknown;
}

type InitSessionFn = (input: { keyword: string; problem: string }) => WrapperSessionShape;

export class RealGroundingClient implements GroundingClient {
  constructor(private readonly initSession: InitSessionFn) {}

  async start(input: GroundingStartInput): Promise<GroundingStartResult | null> {
    // The wrapper's `initSession` is synchronous. Wrap it so a future
    // async-capable wrapper version is a drop-in replacement, and so any
    // synchronous throw becomes a rejected promise we can catch.
    return Promise.resolve()
      .then(() => this.initSession({ keyword: input.keyword, problem: input.problem }))
      .then((session) => ({
        sessionId: session.id,
        currentPhase: session.current_phase,
        mandatorySequence: session.mandatory_sequence,
        activeGuardrails: session.active_guardrails,
        sessionState: session,
      }))
      .catch((err: unknown) => {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            taskId: input.taskId,
            projectSlug: input.projectSlug,
            keyword: input.keyword,
          },
          "grounding-wrapper initSession failed; falling back to advisory hint",
        );
        return null;
      });
  }
}

export class NullGroundingClient implements GroundingClient {
  async start(_input: GroundingStartInput): Promise<GroundingStartResult | null> {
    return null;
  }
}

// Module-cached instance. The factory is stateless and cheap, but the
// `require` of the wrapper module is not free, so we resolve it once.
let cached: GroundingClient | null = null;

export function getGroundingClient(): GroundingClient {
  if (cached) return cached;

  if (process.env.AGENT_TASKS_DISABLE_GROUNDING === "1") {
    cached = new NullGroundingClient();
    return cached;
  }

  try {
    // Defensive: if the wrapper is somehow not installable on a particular
    // deploy, fall through to NullGroundingClient instead of crashing the
    // route handler. We use createRequire so the failure is synchronous
    // and easy to recover from at this point in the import graph.
    const mod = requireFromHere("@lannguyensi/grounding-wrapper") as {
      initSession: InitSessionFn;
    };
    cached = new RealGroundingClient(mod.initSession);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "@lannguyensi/grounding-wrapper not loadable; using NullGroundingClient",
    );
    cached = new NullGroundingClient();
  }

  return cached;
}

// Test-only: reset the cache so a `vi.mock` swap of the wrapper or an env
// flip is picked up. Not exported through the package barrel.
export function __resetGroundingClientCacheForTests(): void {
  cached = null;
}
