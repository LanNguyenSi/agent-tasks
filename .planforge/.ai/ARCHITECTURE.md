# ARCHITECTURE

## Summary

agent-tasks ist eine kollaborative Task-Plattform für Menschen und Agenten. Sie ermöglicht strukturierte Zusammenarbeit rund um Softwareprojekte, inklusive Aufgabenerstellung, Claiming, Review-Handoffs, konfigurierbaren Boards und klaren Verantwortlichkeiten. Agenten arbeiten mit dedizierten API-Tokens, Menschen mit GitHub OAuth. Alle Aktionen sind auditierbar und policy-gesteuert.

## Recommended Shape

- Start with modular monolith as the default architecture.
- Tech stack hint: application stack to be confirmed
- Phase: phase_1
- Path: core

## Scaffold Guidance

- Recommended blueprint: rest-api
- Confidence: medium
- Use the scaffold as the starting point, but verify the generated layout against the plan before implementation expands.
- Treat the scaffold as a baseline, not as the complete repository layout.

## Key Modules

- user-facing application surface
- domain and business logic modules
- persistence and integration boundary

## Integrations

- GitHub OAuth
- GitHub REST API (Repo-Sync, Issue-Sync, PR-Handling)
- GitHub Webhooks

## Risks

- Important open questions remain unresolved and may shift architecture or task scope.
- Third-party integrations may slow delivery or require more explicit failure handling than expected.

## Playbook References

- /root/.openclaw/workspace/git/agent-planforge/playbooks/planning-and-scoping.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/01-project-setup.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/02-architecture.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/03-team-roles.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/04-design-principles.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/05-development-workflow.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/06-testing-strategy.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/07-quality-assurance.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/08-documentation.md
