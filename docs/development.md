# Local development

Running agent-tasks against a local stack: backend on `:3001`, frontend on `:3000`, Postgres in Docker.

## Quick start (Docker)

```bash
git clone https://github.com/LanNguyenSi/agent-tasks.git
cd agent-tasks
cp .env.example .env
echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env   # required, >= 32 chars
make dev-docker     # docker compose up: db + backend + frontend
```

Then open http://localhost:3000.

`docker-compose.yml` brings up Postgres 16, the backend (Hono on `:3001`), the frontend (Next.js on `:3000`), and an optional Redis. The backend transparently falls back to an in-memory cache when `REDIS_URL` is unset, so the redis service is opt-in.

## Quick start (host)

```bash
cp .env.example .env
echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env   # required, >= 32 chars
make install       # install backend + frontend workspace deps
make setup         # prepare .env + generate Prisma client
make db-push       # sync schema to the configured DB
make dev           # backend + frontend in one terminal
```

Or run them in separate terminals:

```bash
make dev-backend
make dev-frontend
```

## Make targets

| Target | Purpose |
|--------|---------|
| `make install` | Install workspace dependencies |
| `make setup` | Prepare `.env` and generate Prisma client |
| `make hooks` | Set up pre-commit hooks (Husky + lint-staged) |
| `make db-generate` | Generate the Prisma client |
| `make db-push` | Push the schema to the configured database |
| `make dev` | Run backend + frontend locally (one terminal) |
| `make dev-backend` | Run only the backend |
| `make dev-frontend` | Run only the frontend |
| `make dev-docker` | Start the full dev stack in Docker |
| `make docker-up` / `make docker-down` / `make docker-logs` | Manage the Docker dev stack |
| `make build` | Build backend and frontend |
| `make test` | Run the test suite |
| `make typecheck` | Run TypeScript checks |
| `make lint` | Run lint checks |
| `make ci` | Run the core CI checks locally |
| `make clean` | Remove local build artifacts |

## Stack

- **Frontend:** Next.js 15 (React 19, App Router)
- **Backend:** Hono + Node.js
- **Database:** PostgreSQL + Prisma
- **Auth:** Email/Password + optional GitHub connect + team-scoped OIDC SSO (humans) + API tokens with scopes (agents)

See [docs/architecture.md](architecture.md) for the repository layout and module boundaries.

## Content-Security-Policy

The frontend sends a `Content-Security-Policy-Report-Only` header (set in
`frontend/src/middleware.ts`) on every response except its own static/image
assets. It's report-only: violations show up in the browser console, but
nothing is blocked yet. `script-src` is `'self'` plus a per-request nonce
(covers the RSC-hydration scripts Next.js itself injects) plus a sha256
hash of the one inline script the app renders (`THEME_INIT_SCRIPT` in
`frontend/src/lib/theme.ts`, injected in `layout.tsx`); `style-src` allows
`'unsafe-inline'` because React's `style={{...}}` prop compiles to an
inline style attribute, which CSP hash/nonce sources don't cover. See the
module doc in `frontend/src/lib/csp.ts` for the full directive-by-directive
rationale.

Enforcing the policy (switching the header to `Content-Security-Policy`,
which will actually block violating requests) is a follow-up task, done
once report-only has run clean in production for a burn-in period. It is
not done yet.

## Contributing

1. Fork the repo.
2. Create a feature branch (`git checkout -b feat/my-feature`).
3. Make your changes and ensure `make ci` passes.
4. Open a pull request.
