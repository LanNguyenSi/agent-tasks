# Contributing to agent-tasks

Thanks for your interest. agent-tasks is a collaborative task platform for humans and agents, with a backend, frontend, CLI, MCP bridge, and MCP server in a single monorepo.

## Issues

- Bug reports: include repro steps, expected vs. actual, and the affected surface (`backend`, `frontend`, `cli`, `mcp-bridge`, `mcp-server`).
- Feature requests: describe the use case before the proposed shape.

## Pull Requests

1. Fork, branch off `master` (e.g. `feat/<scope>`, `fix/<scope>`).
2. Keep changes scoped. Cross-surface refactors should be split.
3. Run the local checks scoped to the affected workspace:

   ```bash
   npm install
   npm run build --workspace=<surface>     # e.g. --workspace=backend
   npm run test  --workspace=<surface>
   ```

   The root-level `npm run build` / `npm test` fan out across all workspaces; only use them when a change actually crosses surfaces.

4. For backend changes, run the dev stack with `docker compose up` and exercise affected endpoints.
5. Open the PR with a clear summary, motivation, and test plan.

## Dev Setup

```bash
git clone https://github.com/LanNguyenSi/agent-tasks.git
cd agent-tasks
npm install
npm run build
```

For the full stack (backend + frontend + Postgres):

```bash
cp .env.example .env
echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env   # required, >= 32 chars
docker compose up
```

## Style

Match the surrounding code. Prefer small, reviewable diffs.

## Workflow round-trip test suite

`backend/tests/workflow/` is the regression net for agent-surface workflow ergonomics: response shapes, byte budgets, and the canonical pickup → start → submit_pr → finish → merge composition.

When changing any verb in the agent surface, the workflow suite is where the size + composition regression net lives. Make sure it stays green and update `BYTES_BUDGET` in `backend/tests/workflow/fixtures.ts` only when calibration evidence supports the new size. The agent-tasks task `47cc3e43-05ac-4975-9c86-60b5224ccda4` carries the calibration table behind the current budgets.
