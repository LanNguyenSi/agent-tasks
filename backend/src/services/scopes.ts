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
  // SSO connection management — team-scoped sensitive write. Enforced in
  // `backend/src/routes/sso.ts` via a direct `actor.scopes.includes(...)`
  // check. Kept in this enum so (a) token-creation validates it as a real
  // scope and (b) the settings UI surfaces it alongside the others.
  "sso:admin",
  // Confidence-gate override (scorer-v2 T6). Required to use `?force=true` to
  // claim a task below the project's confidence threshold (or violating a
  // keystone). Withheld from ordinary task-executing tokens so the gated actor
  // cannot wave itself through; an operator (team admin) mints a token with this
  // scope to grant a deliberate, audited override. Enforced in
  // `services/confidence-gate.ts`.
  "confidence:override",
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

/**
 * Human-facing labels for each scope, shown in the settings UI when a user
 * mints an agent token. Kept in this file so frontend and backend source
 * from the same place and cannot drift; the settings page fetches via the
 * `GET /api/agent-tokens/scopes` endpoint.
 */
export const SCOPE_LABELS: Record<Scope, string> = {
  "tasks:read": "Read tasks",
  "tasks:create": "Create tasks",
  "tasks:claim": "Claim tasks",
  "tasks:comment": "Comment on tasks",
  "tasks:transition": "Transition tasks",
  "tasks:update": "Update task fields (branch, PR, result)",
  "projects:read": "Read projects",
  "boards:read": "Read boards",
  "github:pr_create": "Open pull requests on behalf of a team member (server-side)",
  "github:pr_merge": "Merge pull requests on behalf of a team member (server-side)",
  "sso:admin": "Manage SSO connection (team-scoped, sensitive)",
  "confidence:override": "Override the confidence gate (force-claim a low-readiness task) — operator only",
};

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
  SsoAdmin: "sso:admin",
  ConfidenceOverride: "confidence:override",
} as const satisfies Record<string, Scope>;
