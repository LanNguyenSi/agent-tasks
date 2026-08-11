# MCP response contract v1

Normative reference for the response shape of the `agent-tasks` MCP server
(`mcp-server`). This document defines what every verb response MUST and
MUST NOT contain, independent of any single implementation task. It is the
acceptance basis for the follow-up tasks that implement it (receipt layer,
onboarding channels, error catalog, read-verb `include` semantics) and for
any external integrator building against the MCP surface directly.

Status: v1, targets `mcp-server` 0.13.0 (breaking change). See
[Versioning and rollout](#versioning-and-rollout).

## Motivation

A 14-day audit across 16 Pandora sessions measured tool-token spend with
`mcp-token-audit`. MCP tool traffic accounted for 1.23M of 2.9M total tool
tokens (42%), and roughly 80% of that MCP traffic was `agent-tasks` calls.
Per-verb, the outliers were:

| Verb | Calls | Tokens out | Note |
|---|---:|---:|---|
| `task_start` | 134 | 273k | ~19 tokens in per call; the response carries the full task payload plus onboarding instructions on every call |
| `task_finish` | 130 | 238k | same full-payload pattern on a write verb |
| `tasks_list` | 32 | 109k | deprecated v1 verb, still in active use |
| `task_submit_pr` | 65 | 102k | a metadata write returning a full task object |
| `task_create` | 67 | 98k | the request's own `description` and `templateData` echoed back in the response |
| `projects_list` | 4.9k/call | | used only to resolve a project id to a slug |
| `signals_poll` | 9.5k in one call | | deprecated verb, single-call outlier |

Schema cost (the MCP tool-definition payload itself) is already solved
client-side by deferred tool loading and is out of scope for this contract;
the 92 `ToolSearch` lookups observed in the same audit window cost about 2k
tokens total.

Two design facts explain the shape of the problem, not just its size:

- `tasks_instructions` is deprecated with the note "v2 folds this into the
  `task_start` response". The bulk of `task_start` is therefore intentional
  design (onboarding folded into the transition call), not an oversight.
- Responses today are backend JSON passed through verbatim. There is one
  place to fix this: the `wrap()` layer in `mcp-server/src/client.ts` and
  the per-verb handlers in `mcp-server/src/tools.ts`, not the backend
  itself.

This contract exists to cut the write-verb token cost by roughly an order
of magnitude without losing the information a caller actually needs to act,
by separating "what changed" (always small) from "what you need to read
because something needs attention" (present only when something needs
attention).

## Receipt shape for write verbs

Every write verb (`task_pickup`, `task_start`, `task_create`, `task_respec`,
`task_submit_pr`, `task_finish`, `task_merge`, `task_abandon`, `task_note`,
and their v1 equivalents) returns a **receipt**, not the full backend
object, unless the caller explicitly asks for the full object via
`include` (see [include semantics](#include-semantics-replacing-verbose)).

The receipt has three tiers, layered in a single response object:

```jsonc
// Tier 1: confirm, ALWAYS present. Normative cap: <= ~60 tokens.
{
  "ok": true,
  "task": { "id": "…", "status": "in_progress" },
  "transition": { "from": "open", "to": "in_progress" }, // only on a state change
  "confidence": 87, // bare scalar, create/respec only

  // Tier 2: advise, present ONLY on deviation. Normative cap: <= ~400 tokens.
  "deviations": [
    {
      "code": "CONFIDENCE_BELOW_THRESHOLD",
      "detail": {
        "score": 42,
        "threshold": 60,
        "enforcementMode": "BLOCK",
        "missing": ["acceptanceCriteria"]
      },
      "actNow": "Description is not editable after create except via task_respec; at BLOCK, task_pickup will reject this task.",
      "next": ["task_respec"]
    }
  ],

  // Tier 3: next, optional, 1-3 lines, present when there is an obvious follow-up call.
  "next": ["task_submit_pr after gh pr create"]
}
```

Tier 1 (`confirm`) is the receipt: it answers "did it work, and what is
the task's identity and status now". Tier 2 (`deviations`) is present only
when something needs the caller's attention. Tier 3 (`next`) is an optional
hint at the next verb, not a menu.

### Core rules

Each rule below is normative for every write verb, present and future.

- **Report by exception.** `deviations` MUST be empty or absent on the
  happy path. A deviation is anything that breaks a caller assumption
  (e.g. the description was silently truncated) or has a now-or-never
  action window (e.g. a label was dropped and cannot be set post-create).
  *Why:* the previous design returned the same payload shape regardless of
  whether anything needed attention, so every caller paid full price for
  the rare case. Making the rare case visible and the common case cheap is
  the whole point of the contract.
- **No echo, ever.** Fields the caller sent in the request MUST NOT appear
  in the response. `task_create`'s current `description` +
  `templateData` echo (98k tokens across 67 calls, i.e. roughly half the
  response payload was the caller's own input reflected back) is the
  motivating example and MUST NOT recur in any verb.
  *Why:* the caller already has what it sent; echoing it back is a pure
  token tax with no information gain.
- **Actionable counter-rule.** Deviation detail belongs only in the verb
  where the caller can act on it. Confidence detail (`score`, `missing[]`,
  etc.) belongs on `task_create` / `task_respec`, where the caller can fix
  the spec; on `task_start`, which cannot change the spec, only the bare
  `confidence` scalar is returned.
  *Why:* this is the guard against the receipt regrowing the fat it was
  designed to remove. Detail without an available action is dead weight,
  regardless of tier.

### Deviation catalog: `task_create`

`task_create` is the reference catalog; the codes, triggers, and detail
shapes below are normative for that verb.

| Code | Trigger | `detail` payload | `next` |
|---|---|---|---|
| `CONFIDENCE_BELOW_THRESHOLD` | confidence score is below the project's threshold | `score`, `threshold`, `enforcementMode`, `missing[]` | `task_respec` |
| `DEDUPED_EXTERNAL_REF` | `(projectId, externalRef)` already exists | `existingTaskId`, `existingStatus` | `tasks_get` |
| `DEPENDS_ON_REJECTED` | one or more `dependsOn` ids are invalid or cross-project | `rejected[]`, each with a reason | create again with corrected `dependsOn` |
| `LABELS_DROPPED` | one or more labels were rejected or normalized away | `dropped[]` | create again (agents cannot set labels post-create) |

Other write verbs define their own deviation catalog analogously, in their
own implementation task spec, following the same code/trigger/detail/next
shape. Known catalogs to fill in:

- `task_submit_pr` → open workflow gates (e.g. `branchPresent`,
  `prPresent`, `ciGreen` not yet satisfied)
- `task_finish` → unexpected source state, or a claim conflict
- `task_merge` → a governance-mode conflict (e.g. self-merge blocked)

## `include` semantics replacing `verbose`

Read access to full content is explicit, not implicit. Every verb that can
return more than the receipt accepts:

```
include: ["task" | "description" | "comments" | "instructions" | "artifacts"]
```

`include: ["task"]` is the compatibility valve: it returns the full,
pre-contract object for that verb. Use it as the recovery path after
context loss (a fresh session that needs the whole task, not just the
receipt) or when a caller genuinely needs the full object in one call
instead of composing several narrow ones.

Per-verb defaults without `include`:

| Verb | Default |
|---|---|
| `task_pickup` | full spec, without `comments` |
| `task_start` | receipt only |
| `tasks_get` (and equivalents) | summary |
| `tasks_list` / `project_tasks` | existing summary projection (unchanged) |

`verbose: true/false` (the current flag on `tasks_list`) is superseded by
`include` for any verb this contract touches; existing `verbose` behavior
MUST remain available at minimum via `include: ["task"]` during the
deprecation window.

## Error shape (block tier)

A call that cannot proceed at all is the third receipt tier: a **teaching
error**, not a bare HTTP status or a backend error string forwarded
verbatim.

```jsonc
{
  "ok": false,
  "error": {
    "code": "not_claimed",
    "message": "cannot start: task is not claimed by you",
    "recipe": "call task_pickup (claims atomically) or tasks_claim first",
    "allowedNext": ["task_pickup", "tasks_claim"]
  }
}
```

`recipe` MUST name the concrete corrective call, not just describe the
problem. `allowedNext` MUST list verb names the caller can call immediately,
not a general suggestion. *Why:* a block that only reports failure sends
the caller back to trial and error; a block that also teaches the fix is
what makes minimal responses safe to ship in the first place (see the
Discoverability-regression risk in the plan this contract implements).

### Catalog seed

The block-tier catalog MUST cover at least the following known traps,
each already documented as a 4xx behavior in `mcp-server/src/tools.ts` /
`backend/src/routes/tasks.ts`:

- **Start without a claim.** `task_start` / `task_pickup` return 409 when
  the caller already holds an active claim ("You already hold an active
  claim. Call task_finish or task_abandon on it before picking up new
  work / before starting another.").
- **Branch precondition.** A `branchPresent` / `prPresent` / `ciGreen`
  workflow gate not yet satisfied blocks `task_finish` with 422
  `precondition_failed` and a list of the failing rules.
- **Claim wall / solo multi-task.** The same 409 "already hold an active
  claim" case above, called out separately because it is the common trap
  for callers that try to pick up a second task before finishing the
  first.
- **`cross_repo_pr_rejected`.** `task_submit_pr` rejects a `prUrl` that
  does not point at `project.githubRepo` with 400.
- **`transition force=admin-only`.** The `tasks_transition` /
  `POST /tasks/:id/transition { force: true }` admin bypass returns 403
  for non-admins.
- **Description immutability.** `task_respec` only edits an `OPEN`,
  unclaimed task; any other state (claimed, or not `open`) is rejected
  with 409.
- **`task_finish` `result` as plain string.** `result` is free text
  recorded on the task timeline; it MUST NOT be wrapped in XML or JSON
  tags, and the error/description text MUST say so rather than silently
  accepting and mis-storing structured input.

## Onboarding channels by rate of change

Today, onboarding knowledge is folded entirely into `task_start`, which is
why that verb is 273k tokens across 134 calls for ~19 tokens of input. This
contract splits onboarding by how often the underlying knowledge actually
changes, and moves each kind to the cheapest channel that matches its
change rate:

| Knowledge | Rate of change | Channel |
|---|---|---|
| System / lifecycle / verb ordering | effectively never | `initialize.instructions` (~300-500 tokens, sent once per session) + a `workflow_primer` verb (callable on demand) |
| Project rules | rare | `projects_get_effective_gates` (existing verb, unchanged) |
| Task spec | once per task | `task_pickup` default; `task_start` / `tasks_get` via `include` |
| Per-transition state | every call | the receipt itself, plus `next[]` |
| Correction | error case only | the error shape, via `recipe` |

*Why:* knowledge that never changes belongs in a channel paid for once per
session, not replayed on every transition call. Knowledge that changes
every call (the new state) belongs in the receipt. Conflating the two is
the direct cause of the current per-verb token cost.

## Versioning and rollout

- This contract ships as `mcp-server` 0.13.0, a breaking change (default
  response shapes change for existing callers).
- Release order is server before bridge: `mcp-server` 0.13.0 ships first;
  the `mcp-bridge` pin (currently 0.12.0) bumps only after the server
  release is verified, per the project's release-order convention.
- `include: ["task"]` is the per-call fallback to the old, full-object
  behavior. It MUST remain available for the deprecation window so
  existing callers can opt back in without a code change while they
  migrate.

## Token budgets (normative)

The following are acceptance criteria for every implementation task under
this contract, not aspirational targets:

- Tier 1 (`confirm`): **<= ~60 tokens**, MUST be present on every write
  response.
- Tier 2 (`deviations`, `advise`): **<= ~400 tokens**, MUST be empty or
  absent when there is no deviation.
- Error shape (`block`): sized to be a teaching error, not a payload cap;
  `recipe` and `allowedNext` are required fields regardless of size.

A verb that exceeds its tier's budget on the happy path is a contract
violation, not a judgment call. Implementation tasks MUST include a
budget test (character-count proxy for token count) alongside their
functional tests, per `backend/tests/workflow/` conventions (see
[CONTRIBUTING.md](../CONTRIBUTING.md#workflow-round-trip-test-suite)).
