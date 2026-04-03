# AGENTS

Primary agent instructions live in `.ai/AGENTS.md`.

For machine-readable path discovery, read `planforge-index.json`.

## Read Order

1. `PROJECT.md`
2. `.ai/AGENTS.md`
3. `.ai/ARCHITECTURE.md`
4. `.ai/TASKS.md`
5. `.ai/DECISIONS.md`

## Generated Directories

- Planning state: `planning/`
- Handoff and runner state: `handoff/`
- Tool exports: `exports/`
- Prompts: `prompts/`
- Clarifications: `specs/`
- ADRs: `adrs/`
- Tasks: `tasks/`

## Important Files

- Machine-readable index: `planforge-index.json`
- Planning output: `planning/plan-output.json`
- Structured input snapshot: `planning/structured-input.json`
- Rerun metadata: `planning/rerun-report.json`
- Handoff manifest: `handoff/manifest.json`
- Runner contract: `handoff/runner-contract.json`
- Scaffold export: `exports/scaffoldkit-input.json`
- Review policy export: `exports/devreview.json`

## Working Notes

- Start with the overview docs and `.ai/`, then move into `tasks/`, `adrs/`, and `handoff/` as needed.
- Use `handoff/runner/` for step status and result tracking.
- Treat generated artifacts as guidance, not as permission to skip engineering judgment.

## Current Plan Context

- Planner profile: platform
- Phase: phase_1
- Path: core
