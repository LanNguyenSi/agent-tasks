---
type: invariant
title: "Auth: MCP bridge token resolution and backend validation"
description: "How mcp-bridge resolves and sends a bearer token and how backend/src/middleware/auth.ts hashes and validates it against a stored AgentToken."
tags: [auth, token, mcp-bridge, backend, invariant]
timestamp: 2026-07-05T06:57:53Z
sources:
  - mcp-bridge/src/token-store.ts
  - mcp-bridge/src/cli.ts
  - mcp-server/src/client.ts
  - backend/src/middleware/auth.ts
  - backend/prisma/schema.prisma
---

**Client side, token resolution** (`mcp-bridge/src/token-store.ts`, `resolveTokenStore`): `AGENT_TASKS_TOKEN` env var first (`EnvStore`, read-only), then the OS keychain via a dynamically-imported, runtime-probed `keytar` (`KeytarStore`, any import or probe failure falls through), then a `FileStore` at `$XDG_CONFIG_HOME/agent-tasks/bridge-token` (or `~/.config/agent-tasks/bridge-token`), written atomically with `0o600`/`0o700` perms. `mcp-bridge/src/cli.ts`'s `serve` path calls `store.get()`, throws if no token is available (`"Run 'agent-tasks-mcp-bridge login'..."`), then hands the raw token straight to `runStdioServer({ token, baseUrl })` from `@agent-tasks/mcp-server`, no bridge-side wrapping or re-encoding.

**Client side, request signing** (`mcp-server/src/client.ts`, `AgentTasksClient.request`): every backend call sends `Authorization: Bearer <token>` and `Accept: application/json` headers; the token is the exact string handed in at construction, one static header per request, no per-request nonce or signature.

**Server side, validation** (`backend/src/middleware/auth.ts`, `authMiddleware`): an `Authorization: Bearer <token>` header is SHA-256-hashed (`hashToken`, `createHash("sha256").update(rawToken).digest("hex")`) and looked up against `AgentToken.tokenHash` (`@unique` in `backend/prisma/schema.prisma`). A hit that is not `revokedAt`-set and not past `expiresAt` becomes an `AgentActor{ tokenId, teamId, scopes, userId }`, and `lastUsedAt` is stamped on that same request; a revoked or expired hit short-circuits `401` before the session fallback runs. A Bearer value that doesn't hash-match any `AgentToken` is retried as a session JWT (`verifySessionToken`) for server-to-server callers with no cookie jar; no bearer header at all falls back to the session cookie. The mcp-bridge/mcp-server path always resolves to the `AgentToken` branch, never the session branches, since it only ever presents a raw agent token.

**Storage shape** (`backend/prisma/schema.prisma`, `AgentToken`): `tokenHash String @unique` is the only persisted form of the token (the raw value is never stored, only ever hashed at issuance and at verification), plus `teamId`, `createdById`, `scopes String[]`, `revokedAt`/`expiresAt`/`lastUsedAt` (all nullable), matching exactly the fields `authMiddleware` reads.

Related: `architecture.md`, `backend.md`, `mcp-bridge.md`, `mcp-server.md`.
