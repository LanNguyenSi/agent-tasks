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

For the full stack (backend + frontend + Postgres): `docker compose up`.

## Style

Match the surrounding code. Prefer small, reviewable diffs.
