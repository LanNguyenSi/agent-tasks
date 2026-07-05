# agent-tasks knowledge bundle

An OKF (Open Knowledge Format) v0.1 bundle describing the agent-tasks codebase: a task-tracking system built for AI coding agents, with a stdio MCP surface as the primary agent entry point.

## Overview

- [architecture](architecture.md): the four deployables, how they connect, where state lives, the actor/auth model.
- [task-lifecycle](task-lifecycle.md): the v2 verb surface (task_create/pickup/start/finish/merge/abandon) and the happy-path lifecycle.

## Modules

- [backend](backend.md): the Hono + Prisma API: route layout, services, gate registry, auth middleware.
- [frontend](frontend.md): the Next.js UI: the two independently-authored task list views, the confidence-scorer client mirror.
- [mcp-server](mcp-server.md): the stdio MCP server wrapping the backend REST API over a bearer token.
- [mcp-bridge](mcp-bridge.md): the CLI wrapper that resolves a token (env/keychain/file) and hands off to mcp-server.

## Invariants

- [auth](auth.md): mcp-bridge's token resolution and request signing, and how `backend/src/middleware/auth.ts` hashes and validates the bearer token against a stored `AgentToken`.
- [confidence-scorer](confidence-scorer.md): the authoritative backend scorer vs. the hand-maintained frontend mirror, and the exact spec-section heading aliases both share.
- [governance-merge](governance-merge.md): the governanceMode enum, self-merge/distinct-reviewer gates, and where the webhook and REST merge paths pick different post-merge statuses.
- [workflow-gates](workflow-gates.md): the four transition preconditions, branchName atomic folding, the cross-repo PR guard, externalRef idempotency.
- [claim-model](claim-model.md): task_pickup's resolution order, single-active-claim enforcement, and why status is an unconstrained free string.

## Runbooks

- [release-flow](release-flow.md): the three tag axes and the one publish workflow that cuts a release.
- [deploy](deploy.md): why there is no in-repo deploy automation, and what the prod docker-compose topology actually is.
- [reconcile-done-but-open](reconcile-done-but-open.md): recovering a task whose PR merged but whose record is stuck open.
