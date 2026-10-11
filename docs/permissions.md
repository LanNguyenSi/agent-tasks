# Permissions

## Roles

Team roles (`MemberRole`):

- Admin
- HumanMember
- Reviewer

Agents act through team-scoped agent tokens; what a token may do is set by its [scopes](#token-scopes).

## Matrix

| Action | HumanMember | Reviewer | Admin | Agent |
|---|---:|---:|---:|---:|
| Login | yes | yes | yes | no |
| Create manual project | yes | yes | yes | no |
| Sync GitHub project | yes | yes | yes | no |
| Create task | yes | yes | yes | yes* |
| Claim task | yes | yes | yes | yes* |
| Change workflow | no | no | yes | no |
| Approve review | yes§ | yes§ | yes§ | yes*§ |
| Create agent token | no | no | yes | no |
| Configure team SSO | no | no | no† | token‡ |

`*` Only with the matching token scopes.
`§` Any member with project write access may claim the review lock and approve, subject to the distinct-reviewer rule of the project's `governanceMode`. The Reviewer role controls who receives `review_needed` signals. A custom workflow can restrict the `review → done` edge to a role with `requiredRole`, which `/transition`, `/finish` and `PATCH` check; the v1 `POST /tasks/:id/review` route does not.
`†` SSO configuration is deliberately **not** tied to the ADMIN role: a stolen admin session cookie must not be able to redirect the IdP.
`‡` SSO configuration runs only through an agent token with the `sso:admin` scope. The token is team-scoped and handed out of band to the person responsible for the IdP. See [enterprise-sso.md](enterprise-sso.md).

## Project roles

A project admin can invite a user to a single project with a share invite. The invite grants one of three per-project roles (`ProjectMemberRole`), layered on top of team membership:

- `PROJECT_VIEWER`: read-only. Every write-tier route refuses it.
- `PROJECT_CONTRIBUTOR`: claim, transition, comment and review; the same task rights as a team HumanMember.
- `PROJECT_ADMIN`: also force transitions, workflow edits, project settings, admin release and reassign of claims, and invites. Only a team Admin can mint a `PROJECT_ADMIN` invite.

When a route or a workflow edge checks a team role, `PROJECT_ADMIN` satisfies Admin, HumanMember and Reviewer, `PROJECT_CONTRIBUTOR` satisfies HumanMember and Reviewer, and `PROJECT_VIEWER` satisfies none of them. The mapping lives in `hasProjectRole` and `requireProjectWrite` in [`backend/src/services/team-access.ts`](../backend/src/services/team-access.ts).

## Audit trail

These workflow mutations are written to the audit log and can be read with `GET /api/projects/:id/audit`:

- `workflow.created`: new custom workflow via `POST /api/projects/:id/workflows`
- `workflow.customized`: default forked via `POST /api/projects/:id/workflow/customize`
- `workflow.updated`: `PUT /api/workflows/:id` with a diff summary (state and transition count before and after, added and removed state names, whether `initialState` changed)
- `workflow.reset`: `DELETE /api/projects/:id/workflow` with `affectedTaskCount` (how many tasks the reset detached from the custom workflow)

All workflow mutations are ADMIN-gated, so the audit row always carries an `actorId`.

## Token scopes

The list served by `GET /api/agent-tokens/scopes` is authoritative.

- `tasks:read`
- `tasks:create`
- `tasks:claim`
- `tasks:comment`
- `tasks:transition`
- `tasks:update`
- `projects:read`
- `boards:read`
- `github:pr_create` *(opt-in: server-side PR create through the team's GitHub delegation)*
- `github:pr_merge` *(opt-in: server-side PR merge through the team's GitHub delegation)*
- `sso:admin` *(sensitive: grants create, update and delete on the team's SSO connection; hand out of band, revoke when done)*
- `confidence:override` *(operator-only: allows `?force=true` past the confidence gate)*
