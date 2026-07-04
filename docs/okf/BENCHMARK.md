---
type: benchmark
title: OKF discovery benchmark
description: Before/after measurement of codebase-oracle discovery quality for the OKF Phase-0 pilot.
tags: [okf, benchmark]
timestamp: 2026-07-04T04:02:09Z
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
