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
- [x] OIDC SSO (team-scoped)
- [x] MCP server, MCP bridge and HTTP MCP endpoint
- [x] Confidence enforcement modes (OFF/WARN/BLOCK)
- [x] Task attachments and artifacts

Planned:

- [ ] Further notification channels (email, browser push)
- [ ] Browser end-to-end tests
- [ ] Deploy webhook integration (GitHub Deployments API)
- [ ] Task export (CSV/Excel)
