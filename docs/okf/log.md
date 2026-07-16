# Change log

## 2026-07-16

CI now watches staleness: warn-only `okf-kit check` on every PR
(.github/workflows/okf-staleness.yml, canonical pattern from harness#350).

## 2026-07-05

New invariant doc `auth.md` authored to close the `sources:` granularity gap
the P2c benchmark located (`docs/okf/BENCHMARK.md`, Q8: "How does the MCP
bridge authenticate its requests to the agent-tasks backend?"): the pointers
section on that answer was sourced from `architecture.md`, whose coarse
`sources:` (the four deployables only) don't name any auth-specific file.
Chose the "add a focused concept doc" option over tightening
`architecture.md`'s own `sources:`: a doc scoped tightly to the auth/token
subsystem is both more likely to be the chunk retrieved for auth-shaped
questions and carries the real implementation files
(`mcp-bridge/src/token-store.ts`, `mcp-bridge/src/cli.ts`,
`mcp-server/src/client.ts`, `backend/src/middleware/auth.ts`,
`backend/prisma/schema.prisma`) identified by reading the code, not from
memory. `architecture.md` is left unchanged, keeping its overview role and
coarse `sources:`; `auth.md` is linked from `index.md`'s Invariants section
so it stays reachable. Every claim verified against source at authoring
time. No benchmark re-run in this task, the next measurement point picks it
up. Task: agent-tasks `1c576413-a559-43af-a181-c524710d4ebd`.

## 2026-07-04

Point 6 re-score recorded in `BENCHMARK.md` (sixth point, confirmation run
for the P3 KEEP decision): after codebase-oracle 0.10.0's fail-loud ingest
fix put `backend/src/routes/tasks.ts` into the index (192 chunks), M2 rose
5/12 → 7/12 (first-ever hits on Q6 and Q7, both organic), M1 17/24 → 18/24,
P 10/12 → 11/12. Pre-registered criterion met, KEEP default-on confirmed,
with the recorded caveat that the gains came from organic retrieval of the
newly indexed file, not from expansion injections, and that the Q12
displacement regression persists via the organic-wins dedup rule (refinement
filed as codebase-oracle `d165ff85`). Task: agent-tasks `1190c227`.

P3 sources-expansion measured in `BENCHMARK.md` (fifth point, first
search-side treatment, oracle 0.9.0): M2 4/12 → 5/12 (first-ever hits on Q3
and Q11, one displacement regression on Q12), M1/P unchanged. Two integrity
findings: the benchmark caught the feature silently no-opping in production
(namespace bug, fixed as oracle #64 pre-measurement), and
`backend/src/routes/tasks.ts` turned out to be absent from the index
(codebase-oracle `004f9577`), capping M2 reachability for Q7 in all five
runs and causing the Q12 regression. Pre-registered +2 criterion missed as
measured; operator kept default-on with the deviation recorded, point 6
after the index fix confirms or reverts. Task: codebase-oracle `89f02fa4`.

Answer-LLM comparison recorded in `BENCHMARK.md`: oracle answer LLM swapped
from Groq llama-3.3-70b-versatile to local gemma4-26b-a4b-64k (Mac mini
Ollama, `.env` only). M1 17/24, M2 4/12, P 10/12, all per-question identical
to the P2c run; mean query latency 29.2s. Decision: keep the local model
(removes the 100k-tokens/day cap that stalled P2c; repo content stays
local). Task: codebase-oracle `772874fc`.

P2c consumer re-run recorded in `BENCHMARK.md`: same bundle and index
content, consumer upgraded to codebase-oracle 0.8.0 (frontmatter ingest +
retrieval surfacing). M1 17/24 (= post-bundle, no regressions), M2 4/12
(flat, third identical run), new pointer metric P 10/12 vs 5/12 post-bundle
proxy — the `Pointers` section closes the pointer gap where OKF docs are
retrieved. Next lever: ranking/boost experiment (M2) and finer `sources:`
granularity on coarse docs (Q8 miss). Task: codebase-oracle `707b51ac`.

## 2026-07-03

Upkeep after the first real `okf-kit check` staleness run (5 STALE
warnings): all doc timestamps set to the actual verification datetime
instead of the artificial midnight value, and `sources:` removed from
`BENCHMARK.md`, a benchmark records a measurement rather than describing
repo code, and its previous self-referential `docs/okf/` entry would have
gone stale on every bundle change. No content changes; no sources changed
between authoring and this verification.

`index.md` links switched from bundle-root-absolute (`/name.md`) to
same-directory relative (`name.md`): GitHub resolves a leading `/` against
the repository root, so the absolute form 404s when browsing this directory
on GitHub. Relative links are equally OKF-conformant.

Benchmark comparison recorded in `BENCHMARK.md`: M1 15/24 → 17/24, M2 flat
4/12, both affirmatively wrong baseline answers eliminated. Decision: go for
okf-kit Phase 1, with the oracle frontmatter-awareness work pulled forward.

Initial bundle authored: 13 concept docs (architecture, backend, frontend, mcp-server, mcp-bridge, confidence-scorer, governance-merge, workflow-gates, claim-model, release-flow, deploy, reconcile-done-but-open, task-lifecycle) plus `index.md`. OKF Phase-0 pilot for agent-tasks (task `9cdc0436-4599-44f0-825b-c1c4ed6a3b90`). Every claim verified against source at authoring time.
