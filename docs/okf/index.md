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
- [workflow-gates](workflow-gates.md): the four transition preconditions, branchName atomic folding, the cross-repo PR guard, externalRef idempotency, the `release-ops-no-pr` template for PR-less task classes.
- [claim-model](claim-model.md): backlog filtering and guards, task_pickup's resolution order, single-active-claim enforcement, and why status is an unconstrained free string.

## Runbooks

- [release-flow](release-flow.md): the three tag axes and the one publish workflow that cuts a release.
- [deploy](deploy.md): why there is no in-repo deploy automation, and what the prod docker-compose topology actually is.
- [reconcile-done-but-open](reconcile-done-but-open.md): recovering a task whose PR merged but whose record is stuck open.

## Maintenance

**Quoted-literal drift guard (T-007, agent-tasks tracker 3feb590f)**: okf-kit's `sources-fresh` check compares a doc's frontmatter `timestamp` to its sources' last-commit time; a green run after a re-stamp proves the doc was touched, not that its claims are still true. Batch-43 (task 8a1c4c52, PR #509) shipped two now-fixed claims a re-stamp missed this way: `SERVER_VERSION` quoted as an old value after the source moved on, and a teaching-error `allowedNext` array quoted with the wrong verbs. Three options were weighed for closing that gap:

- **(a) In-repo test, adopted** (`backend/tests/unit/docs-okf-literal-guard.test.ts`, helper in `backend/tests/helpers/okf-literal-guard.ts`): for every markdown block (a blank-line-delimited run of lines) carrying at least one backtick line citation (`path:N`/`path:N-M`, with or without a `#"anchor"`), every VALUE literal in that block (a semver, a quoted string, a JSON-shaped bracket/brace literal, or a `key: value` pair; a bare identifier such as `fooBar`/`foo()`/`Foo.bar` is never checked) must occur, verbatim modulo whitespace, in the source lines of a citation within a word-proximity window of it (`WORD_WINDOW` in `backend/tests/helpers/okf-literal-guard.ts`, currently 30 words, tunable there) on either side, inside the same block. Who pays: doc authors get flagged when an unallowlisted literal drifts from its cited source; readers get a guard that fails on real drift instead of a green `sources-fresh` run that only proves a timestamp moved. False-positive risk: a block that states several literals in one long sentence but cites only one of them can pair a literal with an unrelated nearby citation purely by word proximity; each such case is covered by an allowlist entry (doc, paragraph anchor, literal, reason). More than ten allowlist entries would mean the heuristic no longer fits this bundle, and the decision falls back to (c). `log.md` narrates history (now-superseded values); its literal count is measured but never asserted, the same exemption the bare-citation guard already gives it. Matching is substring-based (`includes()`), which also has a false-negative direction: a short literal (say a two-word `key: value` pair) inside a wide citation window can be silently "verified" by an unrelated in-window line that happens to contain that exact substring. A bare semver is the one kind this guard closes with a boundary check (`0.14.0` no longer matches inside a cited `0.14.0-rc1`); the same substring risk for quoted strings, JSON-shaped literals, and `key: value` pairs is accepted, not fixed.
- **(b) okf-kit rule proposal**: file the same semantics as an opt-in okf-kit check. Who pays: okf-kit maintainers would own and version the rule for every consuming bundle; not filed for this task (scope: agent-tasks docs/okf only).
- **(c) Process only**: re-stamp briefs require every quoted literal to be diffed against its cited line, plus a reviewer read of the sources (already the batch-43 practice). Who pays: every future re-stamp author and reviewer, by discipline rather than a mechanical check; this is the fallback if (a)'s allowlist ever needs more than ten entries.

**Required-status decision**: `.github/workflows/okf-literal-guard.yml` carries no `paths:` filter and runs the guard test on every `pull_request` and every push to `master` under the stable job name "docs/okf literal guard", so it is safe to add to branch protection's required-status list -- a required check that never triggers on some PRs would block them forever, which an always-running trigger cannot do. Who pays: one backend `npm ci` plus the guard test on every PR. An earlier revision instead kept the original `paths:` filter and added a skip-shim job that reconstructed "does this PR affect the guard" from a hand-maintained pattern over a git diff, so a required check could still report success when nothing relevant changed; it was rejected after two review rounds each found a new way the shim silently skipped a relevant PR (a SIGPIPE on a large changed-file list, a rename reported by destination only, a non-ASCII path C-quoted by git) and a new gap in the hand-maintained pattern -- the CHANGELOG carries that history. The branch-protection edit itself (adding "docs/okf literal guard" to the required-status-checks list for `master`) is a separate operator action, not made by this task.
