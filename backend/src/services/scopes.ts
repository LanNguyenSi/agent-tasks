/**
 * Canonical list of scopes an agent token may carry.
 *
 * Previously the scope list was documented in `docs/agent-workflow.md` and
 * checked ad-hoc with `actor.scopes.includes("string")` — so adding a new
 * scope silently required remembering to update every call site. This module
 * is the single source of truth. Route handlers should import `SCOPES` and
 * use the typed constant (e.g. `SCOPES.GithubPrMerge`) rather than a raw
 * string literal.
 *
 * When a new scope is introduced:
 * 1. Add it to `ALL_SCOPES` below.
 * 2. Export a `SCOPES.X` constant.
 * 3. Update `docs/agent-workflow.md` (it reads this file as reference).
 * 4. Existing tokens do NOT auto-gain the scope — operators re-mint.
 */

export const ALL_SCOPES = [
  "tasks:read",
  "tasks:create",
  "tasks:claim",
  "tasks:comment",
  "tasks:transition",
  "tasks:update",
  "projects:read",
  "boards:read",
  // GitHub-delegation scopes — gate the server-side PR create/merge paths
  // that act on behalf of an operator's GitHub identity. Not required for
  // the older gh-CLI workflow where agents carry their own GitHub token.
  "github:pr_create",
  "github:pr_merge",
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

export const SCOPES = {
  TasksRead: "tasks:read",
  TasksCreate: "tasks:create",
  TasksClaim: "tasks:claim",
  TasksComment: "tasks:comment",
  TasksTransition: "tasks:transition",
  TasksUpdate: "tasks:update",
  ProjectsRead: "projects:read",
  BoardsRead: "boards:read",
  GithubPrCreate: "github:pr_create",
  GithubPrMerge: "github:pr_merge",
} as const satisfies Record<string, Scope>;
