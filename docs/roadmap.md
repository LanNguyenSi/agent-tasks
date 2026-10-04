# Roadmap

Shipped:

- [x] GitHub webhook integration (PR lifecycle, review events)
- [x] Agent signal inbox (pull-based, durable signals)
- [x] Review orchestration (review lock, assignee preservation)
- [x] CLI client ([`@agent-tasks/cli`](../cli/README.md))
- [x] Task dependencies (block / blocked-by with cycle detection)
- [x] GitHub PR delegation (create, merge, comment via API)
- [x] CSV/Excel import (Jira auto-mapping)
- [x] Per-project sharing (invite-link, three role tiers, soloMode auto-flip)
- [x] Structured logging (JSON, correlation IDs)
- [x] Workflow templates (pre-built custom workflows, applied per project)
- [x] Notification webhook (per-project outbound webhook for agent signals)

Planned:

- [ ] Further notification channels (email, browser push)
- [ ] E2E and integration tests
- [ ] Deploy webhook integration (GitHub Deployments API)
- [ ] Task export (CSV/Excel)
