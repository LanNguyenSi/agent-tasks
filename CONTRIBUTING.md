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

   The root-level `npm run build` fans out across all workspaces; `npm test` only covers `frontend`, `cli`, and `backend` (not `mcp-server` or `mcp-bridge`). Only use them when a change actually crosses surfaces.

   The root-level `npm run typecheck` works in a fresh checkout without any prior build: `mcp-bridge` typechecks against the `mcp-server` source via a `paths` override in `mcp-bridge/tsconfig.typecheck.json`. Building or testing `mcp-bridge` still requires `npm run build --workspace=mcp-server` first, because build and tests resolve the real package through `node_modules`. Because that `paths` override pulls in `mcp-server`'s source directly, `npm run typecheck --workspace=mcp-bridge` also typechecks `mcp-server`'s source closure as a side effect, so `mcp-server` type errors can surface there too.

4. For backend changes, run the dev stack with `docker compose up` and exercise affected endpoints.
5. Open the PR with a clear summary, motivation, and test plan.

## Dev Setup

This repo uses the orchestrator-workflow kit; what is versioned and what
deliberately is not (and why fresh clones carry no AGENTS.md) is
recorded in [.ai/workflow/README.md](.ai/workflow/README.md).

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

Before changing an `mcp-server` verb's response shape, read [docs/response-contract-v1.md](docs/response-contract-v1.md): it is the normative reference for receipt tiers, `include` semantics, the error shape, and the token budgets that count as acceptance criteria.
