# Orchestrator-workflow kit: what is versioned here, and what deliberately is not

This repo versions the orchestrator-workflow kit's `.ai` layer only: the
run-file templates under `templates/` (exactly 7) and `manifest.json`.
That is what a fresh clone needs so `.ai/runs/` history stays readable
and a kit re-install can diff against a known state.

The kit's ADAPTER layer (an `AGENTS.md` marker section, `CLAUDE.md`,
`.claude/` skills and agent definitions, plus `.agents/`/`.opencode/`
for other harnesses) is deliberately NOT versioned here, matching the
harness repo's precedent. It is per-machine tooling, materialized by
`npx orchestrator-workflow init`, and the corresponding `.gitignore`
block keeps a plain `init` run from leaving accidentally-commitable
files behind. Decision recorded in task c0c672f0.

Where the operating procedure lives:

- the `orchestrator-workflow` package
  (https://github.com/LanNguyenSi/agent-dx, `packages/orchestrator-workflow`),
  whose installer writes the full procedure into `AGENTS.md` on `init` -
  this is the pointer that resolves for any clone;
- operator-local: the pandora workspace root `AGENTS.md` (the collection
  directory this repo is usually cloned into on the operator's machines).

A standalone clone that wants the full procedure locally can run
`npx orchestrator-workflow init` at any time; the generated adapter
files stay untracked by design. CAUTION: `init` also rewrites the
TRACKED `manifest.json` (harnesses, models, installedAt, and hashes of
the adapter files it wrote) - do not commit those machine-specific
entries; discard the manifest diff unless you are deliberately
upgrading the kit.

CI guards the tracking invariant (`.github/workflows/kit-tracking.yml`,
deliberately its own workflow so ci.yml's `**.md` path filter cannot
skip it on template-only PRs): exactly 7 tracked templates (bump the
count there in the same PR when a kit upgrade changes the set),
`manifest.json` tracked, and no tracked kit file matching a gitignore
pattern. A blanket `.ai/` line would not untrack existing files, but it
would make `git add -A` silently skip newly shipped kit files, so the
tracked kit drifts out of sync with the installed one - that drift is
what the job catches.
