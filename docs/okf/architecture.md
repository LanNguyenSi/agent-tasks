---
type: overview
title: "agent-tasks system architecture"
description: "Four independently-deployable components around one PostgreSQL store, with a stdio MCP surface as the agent entry point."
tags: [architecture, backend, frontend, mcp, monorepo]
timestamp: 2026-07-03T10:59:39Z
sources:
  - package.json
  - backend/src/app.ts
  - backend/src/server.ts
  - docker-compose.prod.yml
---

npm workspaces monorepo (`package.json` workspaces: `backend`, `frontend`, `mcp-server`, `mcp-bridge`, `cli`). This doc covers the four deployables; `@agent-tasks/cli` is a fifth workspace (a standalone REST CLI client) not detailed here.

1. **backend** (`@agent-tasks/backend`), a Hono HTTP API (`backend/src/app.ts`, served via `@hono/node-server` in `backend/src/server.ts`), Prisma ORM against PostgreSQL. All routes mount under `/api` (see `backend.md`). Owns all state.
2. **frontend** (`@agent-tasks/frontend`), Next.js 15 app (`frontend/package.json` pins `next@^15.5.18`), the human-facing UI. Talks to the backend over HTTP; has a couple of its own `app/api/*` route handlers only for GitHub OAuth redirects (`frontend/src/app/api/auth/github/*`).
3. **mcp-server** (`@agent-tasks/mcp-server`), stdio MCP server wrapping the backend REST API with a fixed `Authorization: Bearer` token. Published to npm. See `mcp-server.md`.
4. **mcp-bridge** (`@agent-tasks/mcp-bridge`), a thin CLI wrapper around mcp-server that resolves the bearer token (env var, OS keychain, or file) before handing off to the same stdio runtime. See `mcp-bridge.md`.

All state lives in one PostgreSQL database (Prisma schema at `backend/prisma/schema.prisma`); nothing else is a system of record. Prod topology (`docker-compose.prod.yml`) is `db` → one-shot `migrate` (Prisma `db push`) → `backend` and `frontend`, both behind a shared external `traefik` network; see `deploy.md`.

**Actor/auth model**: every request is one of two actor shapes, resolved by `backend/src/middleware/auth.ts` (`backend.md`), a `HumanActor` (browser session cookie, or a session JWT passed as a Bearer token for server-to-server callers) or an `AgentActor` (a SHA-256-hashed `AgentToken` presented as `Authorization: Bearer <raw>`, carrying a `teamId` and a list of `scopes` from `backend/src/services/scopes.ts` that gate individual verbs). The mcp-server/mcp-bridge path is always an `AgentActor`; the frontend is always a `HumanActor`.

Related: `backend.md`, `frontend.md`, `mcp-server.md`, `mcp-bridge.md`, `task-lifecycle.md`.
