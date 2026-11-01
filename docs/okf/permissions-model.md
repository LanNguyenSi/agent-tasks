---
type: invariant
title: "Permissions: team roles, project roles, write tier and token scopes"
description: "Humans are authorized by a team role or a per-project share role, agents by their team and token scopes; hasProjectAccess, requireProjectWrite and hasProjectRole are the three tiers, approval needs only the write tier, and concrete workflow roles are human-only."
tags: [permissions, roles, scopes, access, invites]
timestamp: 2026-11-01T06:26:44Z
sources:
  - backend/prisma/schema.prisma
  - backend/src/services/team-access.ts
  - backend/src/services/scopes.ts
  - backend/src/middleware/auth.ts
  - backend/src/routes/tasks.ts
  - backend/src/routes/github.ts
  - backend/src/routes/projects.ts
  - backend/src/routes/invites.ts
  - backend/src/routes/teams.ts
  - backend/src/routes/agent-tokens.ts
  - backend/src/services/agent-token-service.ts
  - backend/src/routes/sso.ts
  - backend/src/services/review-signal.ts
  - backend/src/services/claim-policy-evaluator.ts
  - backend/src/routes/grounding-task-completion.ts
  - backend/src/routes/grounding-direct-tasks.ts
---

**Three kinds of principal** (`backend/prisma/schema.prisma`): a human holds at most one team role per team (`TeamMember.role`, enum `MemberRole`: `ADMIN`, `HUMAN_MEMBER` as the default, `REVIEWER`) and may hold a per-project role on a project of another team (`ProjectMember.role`, enum `ProjectMemberRole`: `PROJECT_VIEWER`, `PROJECT_CONTRIBUTOR`, `PROJECT_ADMIN`), granted by accepting a `ProjectInvite` share link. An agent token (`AgentToken`) belongs to one team, was created by one user, and carries a `scopes` string array; it has no role. An agent token never satisfies a concrete role (`hasProjectRole` returns false for it); scope checks apply to agent tokens only, and routes behind `requireScope` refuse humans.

**Access tiers** (`backend/src/services/team-access.ts`):

- `hasProjectAccess`: an agent passes when its token's team owns the project, or when the token's creator holds a per-project role there; a human passes with any team role in the owning team or any per-project role.
- `requireProjectWrite`: `hasProjectAccess` plus the write tier. Every agent that passed access is write-capable, since scopes gate it per route; a human passes with any team role, or with `PROJECT_CONTRIBUTOR` or `PROJECT_ADMIN`. The only principal it refuses after access is a human whose single grant is `PROJECT_VIEWER`.
- `hasProjectRole(role)`: see the next paragraph. `isProjectAdmin` is `hasProjectRole` with `ADMIN`.

**Role matching** (`backend/src/services/team-access.ts:229-243#"PROJECT_CONTRIBUTOR"`): the role any delegates to `hasProjectAccess`, so agents pass it. A concrete role is human-only: an agent actor gets false without a lookup. A human's team role must equal the requested role exactly, so a team `ADMIN` does not satisfy a `REVIEWER` or `HUMAN_MEMBER` requirement. A per-project role maps upward: `PROJECT_ADMIN` satisfies `ADMIN`, `HUMAN_MEMBER` and `REVIEWER`, `PROJECT_CONTRIBUTOR` satisfies `HUMAN_MEMBER` and `REVIEWER`, and `PROJECT_VIEWER` satisfies none.

**Where each tier applies** (`backend/src/routes/tasks.ts`): the task reads (the project task list, `GET /tasks/:id`, attachment and artifact reads) check `hasProjectAccess`; `/tasks/claimable` is scoped to the caller's team and checks it only for an explicit project filter. Task mutations check `requireProjectWrite`: create and import, `/start`, `/claim`, `PATCH`, `/respec`, delete, comments, attachment uploads, artifact creation, dependencies, `/merge`, `/review`, `/review/claim` and `/transition`. Approving or requesting changes through `POST /tasks/:id/review` needs only the write tier plus the project's distinct-reviewer rule (see `governance-merge.md`); no team role is required (`backend/src/routes/tasks.ts:8059-8062#"Requires write access"`). A workflow edge's `requiredRole` other than any is checked with `hasProjectRole` by `/transition`, by the `PATCH` status change, and by the shared gate `evaluateV2TransitionGates` that `/start`, `/claim` and `/finish` use; such an edge therefore refuses every agent token, and an edge naming `REVIEWER` refuses a team `ADMIN`. Without a concrete role, `/transition` still requires the write tier (`backend/src/routes/tasks.ts:7794-7799#"Requires write access"`). `POST /tasks/:id/review` does not read `requiredRole`. Forced transitions, `/admin-release` and `/admin-reassign` require `isProjectAdmin`.

**What the project read reports** (`backend/src/routes/projects.ts`, `GET /projects/:id`): the response carries `accessSource` and `accessRole` from `getProjectMembership` (team role first, so a team `HUMAN_MEMBER` or `REVIEWER` who also holds `PROJECT_ADMIN` reports the team role; `null` for an agent of the owning team) and `canAdmin`, the result of `isProjectAdmin` for the caller. `canAdmin` is the same call the admin-gated routes make (the five workflow write routes in `backend/src/routes/workflows.ts` among them), so it is true for a team `ADMIN` and for a `PROJECT_ADMIN` with or without a team membership, and false for the other roles and for every agent. The frontend gates its admin controls on it through `projectCanAdmin` and falls back to `accessRole` only when the response lacks the field. No `canWrite` is returned: every team role is write-capable and a per-project share reports its own role, so `accessRole` already shows the write tier.

**What the REVIEWER team role does**: it is write-capable like every team role, and it has two specific effects: team members with `REVIEWER` or `ADMIN` receive `review_needed` signals (`findEligibleReviewers`, `backend/src/services/review-signal.ts`; see `signals-and-notification-delivery.md`), and a workflow edge can name it as `requiredRole`. No route checks it otherwise.

**Token scopes**: `ALL_SCOPES` in `backend/src/services/scopes.ts` lists the twelve scopes a token may carry; token creation validates the requested scopes against it and defaults to none, and an existing token does not gain a newly added scope. The checks apply to agent actors only. The routes check them as follows (handlers in `backend/src/routes/tasks.ts` unless another file is named):

- `tasks:read`: `/tasks/pickup`, `/tasks/:id/instructions`, `/tasks/:id/suggest-rewrite`, and the attachment and artifact reads. The task list, `/tasks/claimable` and `GET /tasks/:id` check project access only.
- `tasks:create`: task create and import.
- `tasks:claim`: `/tasks/:id/claim`, `/tasks/:id/abandon`, and `/tasks/:id/start` together with `tasks:transition`.
- `tasks:transition`: `/finish`, `/submit-pr`, `/transition`, `/review`, `/review/claim`, and the PR merge route of `backend/src/routes/github.ts` together with `github:pr_merge`.
- `tasks:update`: `PATCH /tasks/:id`, `/respec`, `/creator-abandon`, artifact create and delete, and the PR create route of `backend/src/routes/github.ts` together with `github:pr_create`.
- `tasks:comment`: task comments and the PR comment route of `backend/src/routes/github.ts`.
- `github:pr_create` and `github:pr_merge`: the server-side PR routes of `backend/src/routes/github.ts`; `github:pr_merge` also gates `/tasks/:id/merge` and the auto-merge paths of `/finish`.
- `sso:admin`: the SSO admin routes in `backend/src/routes/sso.ts`, which read the bearer token themselves and require the token's team to match the team in the URL.
- `confidence:override`: a forced claim past a blocking confidence gate (`backend/src/services/claim-policy-evaluator.ts`; see `confidence-scorer.md`).
- `projects:read` and `boards:read`: mintable, but no backend route checks them.

When the grounding runtime is configured, its routers and services run their own scope checks in their admission code, for example `backend/src/routes/grounding-task-completion.ts` and `backend/src/routes/grounding-direct-tasks.ts`.

**Agent-only and human-only routes**: `requireScope` (`backend/src/middleware/auth.ts`) refuses every non-agent actor with 403 before it checks the scope, so the legacy PR create, merge and comment routes in `backend/src/routes/github.ts` accept agent tokens only; the SSO admin routes likewise accept only an agent token with `sso:admin`, never a session. In the other direction, these routes refuse agent tokens: `PATCH /api/projects/:id` (which then requires the project admin role), share-invite creation and acceptance (`backend/src/routes/invites.ts`), agent-token creation, rename and revocation, which need a human team `ADMIN` (`canManageTeamTokens`, `backend/src/services/agent-token-service.ts`), and team rename (`PATCH /api/teams/:id` in `backend/src/routes/teams.ts`, which checks the caller's own `TeamMember` row and needs `ADMIN`: a member of another role gets 403 "Only team admins can rename the team", a non-member 403, an unknown team 404; only the name is written, never the slug); listing a team's tokens needs any team role or a token of that team. A share invite requires a human project admin, and a `PROJECT_ADMIN` invite requires a team `ADMIN`. `docs/permissions.md` is the human-facing matrix.

Related: `auth.md`, `governance-merge.md`, `claim-model.md`, `signals-and-notification-delivery.md`.
