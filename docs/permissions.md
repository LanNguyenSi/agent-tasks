# Permissions

## Rollen
- Admin
- HumanMember
- Reviewer
- Agent

## Matrix

| Action | HumanMember | Reviewer | Admin | Agent |
|---|---:|---:|---:|---:|
| Login | yes | yes | yes | no |
| Create manual project | yes | yes | yes | no |
| Sync GitHub project | yes | yes | yes | no |
| Create task | yes | yes | yes | yes* |
| Claim task | yes | yes | yes | yes* |
| Change workflow | no | no | yes | no |
| Approve review | no | yes | yes | limited |
| Create agent token | no | no | yes | no |
| Configure team SSO | no | no | no† | token‡ |
| Deploy production | limited | limited | yes | no/default |

`*` nur mit passenden Token-Scopes.
`†` SSO-Konfiguration ist bewusst **nicht** an die ADMIN-Rolle gekoppelt — ein gestohlenes Session-Cookie eines Admins darf den IdP nicht umbiegen können.
`‡` SSO-Konfiguration läuft ausschließlich per AgentToken mit Scope `sso:admin`. Das Token ist team-scoped und wird out-of-band an die IdP-verantwortliche Person weitergegeben. Siehe [enterprise-sso.md](enterprise-sso.md).

## Audit-Trail

Folgende Workflow-Mutationen werden in den AuditLog geschrieben und sind über `GET /api/projects/:id/audit` abrufbar:

- `workflow.created` — neuer Custom-Workflow via `POST /api/projects/:id/workflows`
- `workflow.customized` — Default geforkt via `POST /api/projects/:id/workflow/customize`
- `workflow.updated` — `PUT /api/workflows/:id` mit Diff-Summary (state/transition count before/after, renamed states, initialState change)
- `workflow.reset` — `DELETE /api/projects/:id/workflow` mit `affectedTaskCount` (wie viele Tasks durch den Reset vom Custom-Workflow getrennt wurden)

Alle Workflow-Mutationen sind ADMIN-gated, die Audit-Zeile trägt also immer eine `actorId`.

## Token Scopes
- tasks:read
- tasks:create
- tasks:claim
- tasks:comment
- tasks:transition
- projects:read
- boards:read
- sso:admin *(sensitive — grants create/update/delete on the team's SSO connection; hand out-of-band, revoke when done)*
