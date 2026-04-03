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
| Deploy production | limited | limited | yes | no/default |

`*` nur mit passenden Token-Scopes.

## Token Scopes
- tasks:read
- tasks:create
- tasks:claim
- tasks:comment
- tasks:transition
- projects:read
- boards:read
