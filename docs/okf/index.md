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
- [cli](cli.md): the `agent-tasks` REST CLI: v2 verbs and deprecated aliases, task-id prefix resolution, operation keys, the two `tasks list` modes, config precedence, and its missing publish axis.

## Invariants

- [auth](auth.md): mcp-bridge's token resolution and request signing, and how `backend/src/middleware/auth.ts` hashes and validates the bearer token against a stored `AgentToken`.
- [confidence-scorer](confidence-scorer.md): the authoritative backend scorer vs. the hand-maintained frontend mirror, the exact spec-section heading aliases both share, and the claim-time gate (`enforcementMode` OFF/WARN/BLOCK, layered threshold, keystone, force override).
- [governance-merge](governance-merge.md): governance gates, grouped GitHub merge decisions, pending webhook observations and the legacy GitHub webhook ingest (signature, delivery dedup, per-event handling).
- [workflow-gates](workflow-gates.md): the four transition preconditions, branchName atomic folding, the cross-repo PR guard, externalRef idempotency, the `release-ops-no-pr` template for PR-less task classes.
- [claim-model](claim-model.md): backlog filtering and guards, task_pickup's resolution order, single-active-claim enforcement, and why status is an unconstrained free string.
- [signals-and-notification-delivery](signals-and-notification-delivery.md): signal types and their recipients, the pull inbox, acknowledgement on done, and best-effort webhook push delivery behind the egress guard.
- [permissions-model](permissions-model.md): team roles versus per-project share roles, the access, write and role tiers in `team-access.ts`, and where each token scope is checked.

## Runbooks

- [release-flow](release-flow.md): the three tag axes and the one publish workflow that cuts a release.
- [deploy](deploy.md): why there is no in-repo deploy automation, and what the prod docker-compose topology actually is.
- [reconcile-done-but-open](reconcile-done-but-open.md): recovering a task whose PR merged but whose record is stuck open.

## Maintenance

**Quoted-literal drift guard**: okf-kit's `sources-fresh` check compares a doc's frontmatter `timestamp` to its sources' last-commit time, so a green run after a re-stamp proves the doc was touched, not that its claims are still true. `backend/tests/unit/docs-okf-literal-guard.test.ts` (helper in `backend/tests/helpers/okf-literal-guard.ts`) checks part of that gap: for every markdown block (a blank-line-delimited run of lines) carrying at least one backtick line citation (`path:N`/`path:N-M`, with or without a `#"anchor"`), every VALUE literal in that block (a semver, a quoted string, a JSON-shaped bracket/brace literal, or a `key: value` pair; a bare identifier such as `fooBar`/`foo()`/`Foo.bar` is never checked) must occur, verbatim modulo whitespace, in the source lines of a citation within `WORD_WINDOW` words of it (set in the helper) on either side, inside the same block. A literal that pairs with an unrelated nearby citation only by word proximity gets an allowlist entry (doc, paragraph anchor, literal, reason) in `backend/tests/fixtures/okf-literal-guard/allowlist.json`, and the test fails when that list grows past `MAX_ALLOWLIST_ENTRIES`. `log.md` narrates history (now-superseded values): its literals are counted, never asserted. Matching is substring-based (`includes()`), which has a false-negative direction: a short literal inside a wide citation window can be matched by an unrelated in-window line that contains the same substring. A bare semver is the one kind checked with a boundary (`0.14.0` does not match inside a cited `0.14.0-rc1`).

**Required status**: `.github/workflows/okf-literal-guard.yml` has no `paths:` filter and runs the guard test on every `pull_request` and every push to `master` under the stable job name "docs/okf literal guard", so it can be a required status check without blocking a PR it never runs on. Because the guard reads the whole bundle on every run, a PR that shifts a cited source line, even with no docs change, turns it red until the citation is re-verified and re-stamped. The options weighed for this guard and the history of its trigger are in `log.md`.
