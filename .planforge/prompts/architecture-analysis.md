# Prompt: Architecture Analysis

You are working on `agent-tasks`.

## Objective

Validate and refine the recommended architecture for this project.
Use a spec/context/eval lens:

- spec: check that the architecture matches the intended scope and constraints
- context: use the project domain, integrations, security posture, and operating assumptions directly
- eval: call out the evidence and checks needed to validate the recommendation later

## Context

- Summary: agent-tasks ist eine kollaborative Task-Plattform für Menschen und Agenten. Sie ermöglicht strukturierte Zusammenarbeit rund um Softwareprojekte, inklusive Aufgabenerstellung, Claiming, Review-Handoffs, konfigurierbaren Boards und klaren Verantwortlichkeiten. Agenten arbeiten mit dedizierten API-Tokens, Menschen mit GitHub OAuth. Alle Aktionen sind auditierbar und policy-gesteuert.
- Planner profile: platform
- Phase: phase_1
- Path: core
- Recommended architecture: Start with modular monolith as the default architecture.

## Starting Point

- Read `planforge-index.json` first for the generated artifact map.
- Then read `AGENTS.md` and `.ai/ARCHITECTURE.md` before challenging the current recommendation.

## Architecture Options

- option-a: Lean Modular Monolith (modular monolith)
  Summary: One deployable application with explicit domain modules and a single primary data store.
  Scores: delivery=5, ops=5, scale=4, governance=4
- option-b: Modular Monolith With Background Jobs (modular monolith with background jobs)
  Summary: Single primary deployable unit with explicit modules plus a worker path for async workflows and integrations.
  Scores: delivery=4, ops=4, scale=4, governance=4
- option-c: Early Service Separation (small service-oriented split)
  Summary: Separate user-facing application, workflow engine, and integration boundary early for stronger isolation.
  Scores: delivery=2, ops=2, scale=5, governance=3

## Applicable Playbooks

- /root/.openclaw/workspace/git/agent-planforge/playbooks/planning-and-scoping.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/01-project-setup.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/02-architecture.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/03-team-roles.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/04-design-principles.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/05-development-workflow.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/06-testing-strategy.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/07-quality-assurance.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/08-documentation.md

## Risks And Open Questions

Risks:
- Important open questions remain unresolved and may shift architecture or task scope.
- Third-party integrations may slow delivery or require more explicit failure handling than expected.

Open questions:
- TypeScript/Node.js oder Python als Backend-Stack?
- Welche Workflow-Engine für State-Machines (hardkodiert vs. konfigurierbar)?
- Monolith oder Service-Trennung für Auth/Webhook-Handling?

## Expected Output

- Refined architecture recommendation
- Key module boundaries
- Biggest architectural risks
- ADR updates or new ADR proposals
