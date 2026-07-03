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
   top 5 results.

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

Pending. Filled in one commit after the post-bundle run completes: per-question
M1/M2 for both runs, comparison table, failure modes, and the go/no-go
recommendation for okf-kit Phase 1.
