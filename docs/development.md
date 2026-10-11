# Local development

Running agent-tasks against a local stack: backend on `:3001`, frontend on `:3000`, Postgres in Docker.

## Quick start (Docker)

```bash
git clone https://github.com/LanNguyenSi/agent-tasks.git
cd agent-tasks
cp .env.example .env
echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env   # required, >= 32 chars
make dev-docker     # docker compose up: db + redis + backend + frontend
```

Then open http://localhost:3000.

The Docker quick start is a development stack (`NODE_ENV=development`). Set `TRUSTED_PROXY_HOPS=0` in `.env` when no reverse proxy is in front of the backend (see [architecture.md](architecture.md#security-model)).

`docker-compose.yml` brings up Postgres 16, the backend (Hono on `:3001`), the frontend (Next.js on `:3000`), and Redis. The redis container always starts, but the backend uses it only when `REDIS_URL` is set and otherwise falls back to an in-memory cache.

## Quick start (host)

```bash
cp .env.example .env
echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env   # required, >= 32 chars
docker compose up -d db   # or point DATABASE_URL at any reachable PostgreSQL
make install       # install all workspace deps
make setup         # prepare .env + generate Prisma client
set -a; . ./.env; set +a   # the backend and the Prisma CLI do not read the root .env
make db-push       # sync schema to the configured DB
make dev           # backend + frontend in one terminal
```

Export the variables in every terminal that runs `make db-push`, `make dev`, `make dev-backend` or `make dev-frontend`. Set `TRUSTED_PROXY_HOPS=0` in `.env` when no reverse proxy is in front of the backend.

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
| `make db-generate` | Generate the Prisma client |
| `make db-push` | Push the schema to the configured database |
| `make dev` | Run backend + frontend locally (one terminal) |
| `make dev-backend` | Run only the backend |
| `make dev-frontend` | Run only the frontend |
| `make dev-docker` | Start the full dev stack in Docker |
| `make docker-up` / `make docker-down` / `make docker-logs` | Manage the Docker dev stack |
| `make build` | Build backend and frontend |
| `make test` | Run the frontend, cli and backend test suites (backend tests need PostgreSQL, see [Running tests](#running-tests)) |
| `make typecheck` | Run TypeScript checks |
| `make lint` | Run lint checks |
| `make ci` | Run the core CI checks locally |
| `make clean` | Remove local build artifacts |

## Running tests

Backend tests need a reachable PostgreSQL database whose name contains `test`; each run creates and drops its own schema in it. With the Docker database running, create the test database once and run the suites with the variables CI sets:

```bash
docker compose exec db createdb -U agent_tasks agent_tasks_test
NODE_ENV=test \
DATABASE_URL=postgresql://agent_tasks:agent_tasks@localhost:5432/agent_tasks_test \
SESSION_SECRET="$(openssl rand -hex 32)" \
make test
```

`GROUNDING_TEST_DATABASE_URL` can name the test database instead of `NODE_ENV=test` plus `DATABASE_URL`. `make test` covers frontend, cli and backend; `mcp-server` and `mcp-bridge` have their own `npm run test --workspace=<package>`.

## Configuration

The backend validates its environment at startup (`backend/src/config/index.ts`); a few variables are read directly by the module that uses them. `.env.example` lists the common ones.

| Variable | Required / default | Purpose |
|----------|--------------------|---------|
| `DATABASE_URL` | required | PostgreSQL connection URL |
| `SESSION_SECRET` | required, at least 32 characters | Signs session tokens |
| `NODE_ENV` | `development` | `development`, `test` or `production`; with `production`, a backend without `GITHUB_WEBHOOK_SECRET` rejects GitHub webhook deliveries with `401` (with the secret set, signatures are verified in every mode, see [architecture.md](architecture.md#security-model)) |
| `PORT` | `3001` | Backend port |
| `BACKEND_URL` | `http://localhost:3001` | Public backend origin, used for the OIDC callback URL |
| `FRONTEND_URL` | `http://localhost:3000` | Redirect target after login |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated allowed origins |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | empty | GitHub OAuth login, connect and repo sync |
| `GITHUB_WEBHOOK_SECRET` | empty | Webhook signature secret, see [webhook-setup.md](webhook-setup.md) |
| `SSO_ENCRYPTION_KEY` | empty | Required before an SSO connection can be created, see [enterprise-sso.md](enterprise-sso.md) |
| `ALLOWED_GITHUB_LOGINS` | empty (any verified GitHub user) | Comma-separated logins the identity-broker endpoint `POST /api/auth/register-from-project-pilot` may provision |
| `TRUSTED_PROXY_HOPS` | `0` (`.env.example`: `1`) | Number of reverse proxies in front of the backend; the rate limiter reads the client address that many `X-Forwarded-For` entries from the right |
| `REDIS_URL`, `REDIS_KEY_PREFIX` | unset, `agent-tasks:` | Optional shared cache; in-memory without `REDIS_URL` |
| `IDEMPOTENCY_TTL_DAYS` | `30` | Retention of the idempotency dedup tables before the 6-hourly sweep prunes them |
| `GROUNDING_RUNTIME_CONFIG` | empty | Grounding runtime configuration, see [grounding-migration.md](grounding-migration.md) |
| `AGENT_TASKS_DISABLE_GROUNDING` | unset | `1` disables the grounding-wrapper session that pickup and start attach to debug-flavoured tasks |
| `LOG_LEVEL` | `info` in production, `debug` otherwise | Backend log level |
| `UPLOAD_DIR` | `./uploads` | Attachment storage directory, see [attachments.md](attachments.md) |
| `ATTACHMENT_MAX_COUNT_PER_TASK`, `ATTACHMENT_MAX_TOTAL_BYTES_PER_TASK` | `20`, 50 MiB | Per-task attachment caps, see [attachments.md](attachments.md) |
| `ARTIFACT_MAX_COUNT_PER_TASK`, `ARTIFACT_MAX_TOTAL_BYTES_PER_TASK` | `100`, 50 MiB | Per-task artifact caps, see [artifacts.md](artifacts.md) |
| `WEBHOOK_ALLOWED_PRIVATE_HOSTS` | empty | Hosts exempt from the private-address check on notification webhooks, see [notification-webhooks.md](notification-webhooks.md) |
| `ANTHROPIC_API_KEY`, `AGENT_TASKS_REWRITE_MODEL` | unset, `claude-haiku-4-5` | Suggest-rewrite helper, see [llm-rewrite-helper.md](llm-rewrite-helper.md) |
| `NEXT_PUBLIC_API_URL` (frontend) | `http://localhost:3001` | Backend origin for browser calls; baked in at `next build` |
| `API_URL` (frontend) | `http://localhost:3001` | Backend origin for the server-side GitHub login and connect redirects |

### Startup failures

- `Invalid configuration: ...`: a required variable is missing or invalid (for example `SESSION_SECRET` shorter than 32 characters).
- `Backend startup refused: grounding configuration or database prerequisites unavailable`: `GROUNDING_RUNTIME_CONFIG` is invalid or the database is not ready.

Once the backend runs, `GET /api/health` reports the database status.

## Stack

- **Frontend:** Next.js 15 (React 19, App Router)
- **Backend:** Hono + Node.js
- **Database:** PostgreSQL + Prisma
- **Auth:** Email/Password + GitHub OAuth login (`/api/auth/github`) + GitHub connect for existing accounts (`/api/auth/github/connect`) + team-scoped OIDC SSO (humans) + API tokens with scopes (agents)

See [docs/architecture.md](architecture.md) for the repository layout and module boundaries.

## Content-Security-Policy

The frontend sends a `Content-Security-Policy-Report-Only` header (set in
`frontend/src/middleware.ts`) on every response except its own static/image
assets and the app's `/icon.svg` route. It's report-only: violations show
up in the browser console, but nothing is blocked yet. `script-src` is
`'self'` plus a per-request nonce (covers the RSC-hydration scripts
Next.js itself injects) plus a sha256 hash of the one inline script the
app renders (`THEME_INIT_SCRIPT` in `frontend/src/lib/theme.ts`, injected
in `layout.tsx`); `style-src` allows `'unsafe-inline'` because React's
`style={{...}}` prop compiles to an inline style attribute, which CSP
hash/nonce sources don't cover. `img-src` allows
`https://avatars.githubusercontent.com` for GitHub-connect avatars; a
team-scoped SSO deployment must add its own IdP's avatar origin (wherever
the OIDC `picture` claim resolves to) before the enforce flip, or
SSO-linked avatars will be blocked once the header stops being
report-only, and live verification of the policy must be re-run with a
GitHub-linked user before shipping. See the module doc in
`frontend/src/lib/csp.ts` for the full directive-by-directive rationale.

The per-request nonce requires per-request dynamic rendering: Next.js only
applies the nonce to its own injected inline scripts when the route isn't
statically prerendered, so `frontend/src/app/layout.tsx` forces every route
dynamic (see the `await headers()` comment there). This is inherent to
nonce-based CSP, not specific to this app, and is accepted here because
every page is a client-side dashboard served with no CDN in front of it --
the trade-off removed what had been a year-long public cache lifetime on
otherwise-authenticated shells, which was a bigger problem than losing
static prerendering.

Enforcing the policy (switching the header to `Content-Security-Policy`,
which will actually block violating requests) is a follow-up task, done
once report-only has run clean in production for a burn-in period. It is
not done yet. There is no `report-uri`/`report-to` collector wired up in
this task, so violations only ever surface in an end user's own browser
console -- there is no server-side visibility into report-only violations
today. Until a collector exists (a prerequisite worth adding as part of
the enforce-flip follow-up), "burn-in" means whoever flips the header
manually spot-checks the browser console on a handful of named pages
(the dashboard, a task detail page, and `/auth`) rather than watching an
aggregate violation count.

Changing the API origin (`NEXT_PUBLIC_API_URL`, which also feeds
`connect-src`) requires rebuilding the frontend image: it's a build-arg
baked into the static output at `next build` time, not something that can
be swapped by changing an environment variable on an already-built
container.

## Contributing

1. Fork the repo.
2. Create a feature branch (`git checkout -b feat/my-feature`).
3. Make your changes and ensure `make ci` passes (backend tests need PostgreSQL, see [Running tests](#running-tests)).
4. Open a pull request.
