---
type: benchmark
title: OKF discovery benchmark
description: Before/after measurement of codebase-oracle discovery quality for the OKF Phase-0 pilot.
tags: [okf, benchmark]
timestamp: 2026-07-04T07:00:42Z
---

# OKF discovery benchmark

Measures whether the curated OKF bundle in this directory improves
[codebase-oracle](https://github.com/LanNguyenSi/codebase-oracle) discovery
over the agent-tasks repo. Part of the OKF Phase-0 pilot (agent-tasks task
`9cdc0436-4599-44f0-825b-c1c4ed6a3b90`); the outcome gates whether an okf-kit
gets built at all.

## Methodology

Two runs with an identical protocol, before and after the OKF bundle lands in
the index:

- **Baseline:** current index, no `docs/okf/` concept docs present.
- **Post-bundle:** after the bundle is merged and `oracle_reindex` has run.

Protocol per question, per run:

1. One `oracle_query` call, `repo="agent-tasks"`, question text verbatim.
2. One `oracle_search` call, `repo="agent-tasks"`, question text verbatim,
   `limit=10`; rows from `docs/okf/BENCHMARK.md` are dropped (this file
   contains the question text verbatim and would otherwise match itself in
   the post-bundle run), then the first 5 remaining rows count for M2. In the
   baseline run the filter is a no-op since this file is not yet indexed.

Environment (must be identical for both runs): codebase-oracle 0.6.5 (local
source via tsx), embeddings `openai/text-embedding-3-small`, answer LLM
`openai-compatible/llama-3.3-70b-versatile`.

### Integrity rules

- This question set and the scoring rubric were written and committed BEFORE
  any bundle authoring started (this file's git history is the proof).
- The ground-truth answer key is verified against source with file:line
  evidence but intentionally NOT committed to this repo until scoring is
  complete, so the oracle index cannot retrieve answers from the key itself.
- The bundle authors were briefed without access to this file; bundle
  coverage is defined by the pilot task's acceptance criteria, not by these
  questions.
- Citations of `docs/okf/BENCHMARK.md` itself never count as evidence; an
  answer whose only support is this file scores 0.

### Scoring rubric

- **M1, answer correctness** (`oracle_query`), judged against the answer key
  by the same judge in both runs:
  - 2 = correct: the key facts are present and no materially wrong claim is
    made; cited sources include at least one ground-truth file.
  - 1 = partial: right area or right mechanism, but a key fact is missing or
    a minor claim is wrong.
  - 0 = wrong or missing: materially incorrect, hallucinated, or no answer.
- **M2, retrieval hit@5** (`oracle_search`): 1 if any of the top-5 chunks
  comes from a ground-truth file for that question, else 0.

## Questions

| # | Question |
|---|----------|
| Q1 | When a pull request gets merged, how does the linked task's status get updated, and how does the project's governance mode (e.g. soloMode) affect whether the task auto-completes? |
| Q2 | Where is the task confidence scorer implemented, and why do two copies of it exist? |
| Q3 | How are releases tagged in agent-tasks, and what does each tag pattern trigger? Is there a required publish order? |
| Q4 | What precondition does task_start enforce regarding git branches, and how do I satisfy it in one call? |
| Q5 | What happens if task_finish is called with a prUrl that belongs to a different GitHub repository than the project's configured repo? |
| Q6 | How can I create tasks idempotently so re-running a bulk import doesn't create duplicates? |
| Q7 | How does task_pickup choose which task to hand out, and what stops an agent from claiming two tasks at once? |
| Q8 | How does the MCP bridge authenticate its requests to the agent-tasks backend? |
| Q9 | What happens automatically after a PR is merged to master in terms of deployment, and where is that configured? |
| Q10 | Which markdown sections does the confidence scorer extract from a task description, and where is that parsing implemented? |
| Q11 | What task statuses exist, and can an agent force a status transition directly? |
| Q12 | What is debugFlavor on a task, and when/where is it decided if the creator didn't set it? |

## Results

### Baseline (committed before bundle authoring started)

Scores only; per-question rationale and the answer key land with the final
comparison so the index cannot serve answers back to the post-run.

| Q | Q1 | Q2 | Q3 | Q4 | Q5 | Q6 | Q7 | Q8 | Q9 | Q10 | Q11 | Q12 | Total |
|---|----|----|----|----|----|----|----|----|----|-----|-----|-----|-------|
| M1 | 1 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 2 | 1 | 1 | 2 | 15/24 |
| M2 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 1 | 4/12 |

### Final comparison (post-bundle run: 2026-07-03, after merge of #385 + reindex)

| Q | Q1 | Q2 | Q3 | Q4 | Q5 | Q6 | Q7 | Q8 | Q9 | Q10 | Q11 | Q12 | Total |
|---|----|----|----|----|----|----|----|----|----|-----|-----|-----|-------|
| M1 baseline | 1 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 2 | 1 | 1 | 2 | 15/24 |
| M1 post | 1 | 2 | **2** | 1 | 1 | 1 | 1 | 1 | 2 | **2** | 1 | 2 | **17/24** |
| M2 baseline | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 1 | 4/12 |
| M2 post | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 1 | 4/12 |

Headline findings:

- **Both affirmatively wrong baseline answers were eliminated.** Baseline
  claimed no required npm publish order exists (Q3) and presented an
  incomplete spec-section list as complete (Q10); both post-run answers are
  fully correct, and in both cases an OKF concept doc is among the corrected
  answer's cited sources (for Q10 alongside the implementation file that was
  already retrieved at baseline, so causality is likely but not isolated).
  Wrong answers are the worst failure mode for agent consumers, so this is
  the strongest single result.
- **M1 +2 with no regressions**, plus substance gains inside the 1-score band
  on three further questions (selection ordering, backend-side token
  validation, status-column looseness) that the integer rubric does not
  reward: those answers now contain the previously missing key facts but
  still cite prose docs instead of implementation files, and the committed
  rubric requires an implementation-file citation for a 2.
- **M2 flat at 4/12.** The ground-truth set is implementation files; the
  bundle adds prose, and natural-language queries keep retrieving prose.
  Retrieval of implementation files did not improve. The likely mechanism,
  not directly measured in this run: the `sources:` frontmatter pointers sit
  inside the retrieved chunks, but the oracle has no frontmatter awareness
  and does not surface them as citations; that would be consumer-side work
  (frontmatter-aware indexing/citation), not bundle-side.
- Observational, defined post-hoc: OKF docs appear in the post-filter top-5
  search rows for 8/12 questions and among `oracle_query` cited sources for
  11/12.
- Integrity notes: the answer key stays uncommitted (kept outside the repo)
  so the benchmark remains re-runnable for later consumer-side measurements
  without the index serving answers back; BENCHMARK.md matched once in
  search (Q3, dropped per protocol) and holds no answer content; single run
  per question per phase, nondeterminism noise unquantified.

### Decision

**Go for okf-kit Phase 1, with one adjustment.** Measurable improvement: yes
(M1 15→17, wrong answers 2→0, on a repo that was already densely documented,
deliberately the hardest test). The flat M2 localizes the remaining value in
the consumer: per the likely mechanism above, the pointer-carrying
frontmatter is retrieved but not exploited. Adjustment: pull the
citation/pointer part of Phase 2
(codebase-oracle frontmatter awareness) forward next to the Phase-1 kit
rather than strictly after it, and fix the M1 rubric's citation criterion
(count pointers in the answer text) in the kit's benchmark template.

### P2c consumer re-run (2026-07-03/04, frontmatter-aware oracle 0.8.0)

Third measurement point: same bundle, same index content, upgraded consumer
(codebase-oracle 0.8.0: P2a frontmatter ingest #60 + P2b retrieval surfacing
#61, PR numbers in the codebase-oracle repo). Task: codebase-oracle
`707b51ac` (okf-benchmark-rerun-consumer).

Environment vs pilot: answer LLM UNCHANGED
(openai-compatible/llama-3.3-70b-versatile), embeddings UNCHANGED
(openai/text-embedding-3-small), oracle 0.6.5 → 0.8.0 (the treatment).
Index state: master aef195e, fresh oracle_reindex. Incident, documented for
integrity: the answer LLM's daily token window was exhausted mid-run
(unrelated infra limit); the affected five oracle_query calls (Q8-Q12) were
re-collected with identical protocol and config once the window freed
(Q8-Q10 the same evening, Q11-Q12 the next morning; the index was verified
unchanged, master still aef195e). oracle_search was unaffected.

New metric P ("pointer in answer text"), pre-declared in the Phase-0
decision: 1 if any ground-truth file path appears in the oracle_query ANSWER
TEXT (prose, Sources list, or the 0.8.0 `Pointers (from OKF sources
metadata):` section). For the two pilot runs P is derived from the judge
tables' recorded citations (proxy). M1 keeps the pilot rubric unchanged —
the mechanical Pointers section does NOT satisfy the M1 citation criterion,
otherwise M1 would stop being comparable; pointer credit is what P measures.

| Q | Q1 | Q2 | Q3 | Q4 | Q5 | Q6 | Q7 | Q8 | Q9 | Q10 | Q11 | Q12 | Total |
|---|----|----|----|----|----|----|----|----|----|-----|-----|-----|-------|
| M1 baseline | 1 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 2 | 1 | 1 | 2 | 15/24 |
| M1 post-bundle | 1 | 2 | 2 | 1 | 1 | 1 | 1 | 1 | 2 | 2 | 1 | 2 | 17/24 |
| M1 P2c | 1 | 2 | 2 | 1 | 1 | 1 | 1 | 1 | 2 | 2 | 1 | 2 | 17/24 |
| M2 baseline | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 1 | 4/12 |
| M2 post-bundle | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 1 | 4/12 |
| M2 P2c | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 1 | 4/12 |
| P baseline (proxy) | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 1 | 4/12 |
| P post-bundle (proxy) | 0 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 1 | 5/12 |
| P P2c | **1** | 1 | 1 | **1** | **1** | 0 | **1** | 0 | 1 | 1 | **1** | 1 | **10/12** |

Headline findings:

- **Pointer surfacing works where an OKF doc is retrieved.** P: 10/12 vs
  5/12 (post-bundle proxy) and 4/12 (baseline proxy): the `Pointers` section
  now injects ground-truth implementation paths into the answer text even
  when the prose-grounded answer cites only docs. This was the consumer gap
  the Phase-0 decision named. On Q11 the pointers carry BOTH ground-truth
  files while the Sources list has none of them.
- **The two P misses are instructive, not random.** Q6: no OKF doc in the
  retrieved context at all → no Pointers section (a retrieval gap, bundle- or
  ranking-side, not a surfacing gap). Q8: Pointers present but sourced from
  architecture.md, whose coarse `sources:` list (the four deployables) does
  not include the auth-specific files → doc/`sources:` granularity bounds
  pointer quality.
- **M1 17/24, identical to post-bundle** (baseline 15/24): the pointer
  section adds file paths, not facts, and the unchanged rubric deliberately
  ignores it for the citation criterion. No regressions; Q1 gained its last
  missing key fact (REST merge endpoint hardcodes done) but stays at 1 under
  the rubric's citation cap.
- **M2 flat at 4/12 for the third time, identical hit set** (Q2, Q9, Q10,
  Q12). Expected: P2b changes what answers SHOW, not what the vector search
  ranks. Closing M2 needs a ranking/boost experiment (type-aware boosting,
  or sources-expansion at search time) — that is the follow-up decision this
  run informs.

### P2c verdict

**Pointer surfacing (P2a+P2b) closed the pointer gap it targeted**
(P 5/12 → 10/12, with zero M1 regressions), and the gap that remains is now
precisely located: retrieval ranking (M2 flat across three runs, plus the Q6
retrieval miss) and `sources:` granularity on coarse docs (Q8). A
ranking/boost experiment is warranted as the next consumer-side lever;
bundle-side, splitting architecture.md's coarse `sources:` into
per-subsystem docs would lift pointer quality where it is currently bounded.

### Answer-LLM comparison (2026-07-04, local gemma4-26b vs Groq llama-3.3-70b)

Fourth measurement point, about the ANSWER MODEL, not the consumer: same
bundle, same index content (master aef195e, no reindex since the P2c run),
same embeddings (openai/text-embedding-3-small), same oracle version
(0.8.0), same judge and rubric. The only change vs the P2c run: the answer
LLM behind oracle_query moved from Groq `llama-3.3-70b-versatile` (the
hosted openai-compatible lane of all prior runs; its 100k-tokens/day cap
stalled the P2c collection twice) to `gemma4-26b-a4b-64k` on a local Mac
mini via Ollama's OpenAI-compatible endpoint (`.env` swap only, no code
change). Task: codebase-oracle `772874fc` (oracle-answer-llm-local-ollama).

Collection note: answers were collected via the oracle CLI (same
queryCodebase/searchCodebase pipeline as the MCP tools; the running MCP
server keeps its pre-swap environment until reconnect). Runner/judge
separation kept as in all prior runs.

| Q | Q1 | Q2 | Q3 | Q4 | Q5 | Q6 | Q7 | Q8 | Q9 | Q10 | Q11 | Q12 | Total |
|---|----|----|----|----|----|----|----|----|----|-----|-----|-----|-------|
| M1 llama-70b (P2c) | 1 | 2 | 2 | 1 | 1 | 1 | 1 | 1 | 2 | 2 | 1 | 2 | 17/24 |
| M1 gemma4-26b | 1 | 2 | 2 | 1 | 1 | 1 | 1 | 1 | 2 | 2 | 1 | 2 | 17/24 |
| M2 llama-70b (P2c) | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 1 | 4/12 |
| M2 gemma4-26b | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 1 | 4/12 |
| P llama-70b (P2c) | 1 | 1 | 1 | 1 | 1 | 0 | 1 | 0 | 1 | 1 | 1 | 1 | 10/12 |
| P gemma4-26b | 1 | 1 | 1 | 1 | 1 | 0 | 1 | 0 | 1 | 1 | 1 | 1 | 10/12 |

Headline findings:

- **Per-question identical on every metric.** M1 17/24 with the same
  question-level scores, M2 the same hit set (Q2/Q9/Q10/Q12), P the same two
  misses (Q6 retrieval gap, Q8 `sources:` granularity). The 26B (4B active)
  local model gives up nothing measurable against the hosted 70B on this
  benchmark.
- **Substance inside the 1-score band moved up, not down.** Q7 is the first
  answer across all four runs with every key fact (selection ordering,
  blockedBy filter, atomic signal ack, both 409 claim walls, CAS race);
  Q11 recovered the status-is-a-free-String nuance the P2c re-run had lost;
  Q12's heuristic description is the richest yet. No substance regressions
  were found anywhere.
- **The failure modes are consumer/bundle-shaped, not model-shaped.** The
  same questions fail the same way under two very different answer models:
  M2 stays 4/12 (ranking), Q6 stays pointer-less (no OKF doc retrieved),
  Q8's pointers stay off-target (coarse `sources:`). This strengthens the
  P2c conclusion that the next levers are retrieval ranking and `sources:`
  granularity, not answer-model quality.
- **Cost profile**: local synthesis averaged 29.2s per query (range
  22.6-44.7s) vs Groq's near-instant responses; in exchange the daily token
  cap disappears (the P2c run lost most of a day to it) and repo content no
  longer leaves the tailnet for inference.

Decision: **keep the local Ollama answer LLM as the default.** Criterion was
M1/P delta + latency: the delta is zero on all metrics, and ~30s per query is
acceptable for agent workflows while removing the hard operational blocker.
Revert path stays documented in the oracle `.env` (Groq lane commented out
in place).

### P3 sources-expansion re-run (2026-07-04, oracle 0.9.0)

Fifth measurement point, the first SEARCH-side treatment: codebase-oracle
0.9.0 ships sources-expansion (oracle PRs #63 + namespace fix #64) — when a
retrieved chunk carries OKF `sources:` frontmatter, the pointed-at files are
injected into the oracle_search result list directly after their parent row,
marked `[expanded from <doc>]`, capped and deduped, default-on. Task:
codebase-oracle `89f02fa4` (oracle-okf-ranking-boost-experiment); the
operator-approved design chose this treatment over type-aware boosting.

Environment: index content unchanged since the P2c reindex (expansion works
at query time, no reindex), embeddings unchanged, answer LLM = local
gemma4-26b (the answer-LLM comparison run above is the same-LLM reference).
Measured build: oracle 0.9.0 PLUS the namespace fix #64 (master a3f48d3);
plain 0.9.0 exhibits the no-op described below. M2 is the PRIMARY endpoint;
M1/P secondary.

Two findings this run surfaced, recorded for integrity:

1. **The benchmark caught a production no-op.** The feature passed 299 unit
   tests plus a purpose-built eval fixture and still did nothing on real
   repos: OKF `sources:` entries are repo-root-relative while the store
   indexes file paths with a repo prefix, and every test fixture had been
   written in a self-consistent wrong namespace. The first collection run
   showed zero expanded rows; fix merged as oracle #64 before this
   measurement. Fixtures must be derived from production data shape.
2. **Ground-truth reachability caveat for ALL runs:** `backend/src/routes/
   tasks.ts` (the largest, most load-bearing implementation file) has zero
   chunks in the index (silent ingest drop, filed as codebase-oracle
   `004f9577`). M2 was therefore never winnable for Q7 (its only
   ground-truth file) in ANY of the five measurement points, and expansion
   cannot inject it either.

Known self-reference caveat, restated for this section: BENCHMARK.md is
itself indexed, and its accumulating aggregate findings name ground-truth
files. M2 stays unaffected (BENCHMARK.md search rows are dropped by
protocol), but future M1/P scores can be inflated by answers grounding in
this file; the integrity rules already discount BENCHMARK.md citations as
evidence.

| Q | Q1 | Q2 | Q3 | Q4 | Q5 | Q6 | Q7 | Q8 | Q9 | Q10 | Q11 | Q12 | Total |
|---|----|----|----|----|----|----|----|----|----|-----|-----|-----|-------|
| M2 all four prior runs | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 1 | 4/12 |
| M2 P3 (expansion) | 0 | 1 | **1** | 0 | 0 | 0 | 0 | 0 | 1 | 1 | **1** | **0** | **5/12** |

Headline findings:

- **The mechanism works where its inputs exist.** Q3 and Q11 are the first
  M2 hits for those questions in five runs: release-flow.md injected
  `.github/workflows/release.yml` at rank 2, claim-model.md injected
  `backend/prisma/schema.prisma` at rank 4. Expanded rows appeared on 11/12
  questions (Q6: no OKF doc retrieved, the known retrieval gap — expansion
  correctly did nothing).
- **The one regression shares a root cause with the biggest blocked win.**
  Q12 dropped 1→0: task-lifecycle.md's FIRST source is the unindexed
  tasks.ts, so its second source (non-ground-truth `mcp-server/src/tools.ts`)
  was injected instead and displaced the organic ground-truth hit from rank
  5 to 6. With tasks.ts indexed, both Q12's and Q7's first-source injections
  become ground-truth hits: projected M2 7/12.
- **Boundary effects bound two further wins:** Q1 and Q5 inject their
  ground-truth files at ranks 6-7, just past the top-5 cut (the parent doc
  ranks 3rd/5th and the ground-truth file is not the first source).
- M1 17/24 and P 10/12 are unchanged vs the answer-LLM run, as designed:
  the treatment touches oracle_search only. Query latency mean 21.0s.

### P3 decision

The pre-registered keep/revert criterion (M2 gain ≥ +2 without precision
regression) was NOT met as measured: net +1 with one displacement
regression. The operator reviewed the attribution — the regression and the
largest blocked gains share the single orthogonal root cause `004f9577`
(unindexed file), and the mechanism itself performed exactly as designed —
and decided to KEEP sources-expansion default-on. This deviation from the
pre-registered rule is recorded here deliberately. Confirmation path:
fix `004f9577`, then measurement point 6 re-scores M2 (projected 7/12);
if it fails to confirm, the default flips off.

### Point 6 re-score (2026-07-04, oracle 0.10.0, tasks.ts indexed)

Sixth measurement point, the confirmation run required by the P3 decision.
Treatment: codebase-oracle 0.10.0 (oracle PR #65, task `004f9577`) fixed the
silent ingest drop: the per-file size limit became explicit config with a
loud per-file skip report, its default rose from 200 KB to 500 KB, and
`backend/src/routes/tasks.ts` (207,716 bytes) entered the index for the
first time: 192 chunks covering the whole file. The query pipeline is
byte-identical to point 5 (the 0.10.0 change is ingest-only).

Environment: agent-tasks index delta vs point 5 is exactly three files
(tasks.ts new; BENCHMARK.md + log.md refreshed by the point-5 results merge,
meta-docs whose search rows the protocol drops). Embeddings unchanged, answer
LLM local gemma4-26b (same as points 4-5), protocol and rubric unchanged,
runner blind to the key. Pre-registered decision rule, written before
collection: confirm KEEP if M2 ≥ 6/12 with no NEW expansion-attributable
precision regression, else the default flips off.

| Q | Q1 | Q2 | Q3 | Q4 | Q5 | Q6 | Q7 | Q8 | Q9 | Q10 | Q11 | Q12 | Total |
|---|----|----|----|----|----|----|----|----|----|-----|-----|-----|-------|
| M2 points 1-4 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 1 | 4/12 |
| M2 P3 (point 5) | 0 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 1 | 0 | 5/12 |
| M2 point 6 | 0 | 1 | 1 | 0 | 0 | **1** | **1** | 0 | 1 | 1 | 1 | 0 | **7/12** |

Headline findings:

- **M2 7/12: the projection was hit, but by a different road than
  projected.** Q6 and Q7 are first-ever hits in six runs, and BOTH are
  ORGANIC: the newly indexed tasks.ts chunks rank in the top-5 on their own
  (Q6: the import-endpoint chunks at ranks 2-3, beyond projection, since Q6 had
  been written off as unreachable-by-expansion; Q7: the pickup handler at
  rank 5, exactly the ground-truth lines). The projected injection-recovery
  never happened, and structurally could not: once a pointed-at file is
  retrieved organically, the organic-wins dedup rule suppresses its
  injection.
- **Q12 stays lost, and the known displacement regression persists via a new
  path.** task-lifecycle.md's tasks.ts pointer now resolves, but tasks.ts
  sits organically at rank 6 (one past the cut), so dedup skips the
  injection and the non-ground-truth sibling (mcp-server/src/tools.ts)
  injects at rank 2, pushing the organic ground-truth rows from ranks 5/6 to
  6/7. Without expansion, this run's Q12 top-5 would contain the hit.
  Refinement filed as codebase-oracle `d165ff85`: hoist a below-cut organic
  hit next to its parent instead of skipping the injection (the same pattern
  bounds Q1/Q5, whose ground-truth injections land at ranks 6-7).
- **First M1 movement since the bundle landed: 17/24 → 18/24.** Q4 and Q7
  each gained a point because tasks.ts chunks are now retrievable into the
  answer context: the missing key facts appeared (Q4: the 422; Q7: the
  priority-desc/createdAt-asc ordering and blockedBy filter) and the
  ground-truth file is finally cited in Sources. Q2 dropped 2 → 1 this run
  (the fixture-parity fact absent from the answer text); same model, same
  config, judged as sampling variance on a secondary metric, recorded for
  integrity.
- **P 11/12** (from 10/12): Q6 flips because the answer now cites
  tasks.ts with line references in prose (organic, since Q6 retrieves no
  OKF doc and therefore has no Pointers section). Only Q8 remains, the known
  `sources:` granularity bound (task `1c576413`).
- Query latency mean 26.3s (19.2-39.1s), in line with the gemma4 runs.

### Point 6 decision

The pre-registered criterion is MET: M2 7/12 (≥ 6/12; +3 vs the 4/12
pre-expansion reference, +2 vs point 5) with no new expansion-attributable
regression (Q12 is the same regression known since point 5, persisting
through the dedup path). **KEEP default-on is confirmed.** Recorded with the
attribution caveat that point 6's marginal gains came from the index fix
(organic retrieval), not from expansion injections. Decomposed on the
current index, expansion's direct net contribution is +Q3 −Q12 = 0: Q11,
an injection win at point 5, now hits organically (tasks.ts rank 3) and its
schema.prisma injection is merely redundant, so the KEEP rests on the
pre-registered M2 level being reached, not on expansion's standalone net.
The dedup-hoist refinement (`d165ff85`) is the identified next lever for
turning the Q1/Q5/Q12 boundary losses into wins.
