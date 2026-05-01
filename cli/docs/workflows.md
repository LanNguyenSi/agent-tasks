# Workflows

End-to-end examples beyond the simple claim-then-review path. All examples assume `AGENT_TASKS_ENDPOINT` and `AGENT_TASKS_TOKEN` are set, see [configuration.md](configuration.md).

## 1. Standard work loop (signal, work, PR, review)

```bash
# 1. Get the next thing to do, signal, review, work, or idle
agent-tasks pickup

# 2. Begin work, atomic claim + transition. Fetch instructions separately.
agent-tasks tasks start <task-id>
agent-tasks tasks instructions <task-id>

# 3. Do the work locally, then push the branch and open a PR.
gh pr create --base master --head feat/x --title "feat: my change"

# 4. Attach the PR to the task
agent-tasks tasks submit-pr <task-id> \
  --branch feat/x \
  --pr-url https://github.com/acme/repo/pull/42 \
  --pr-number 42

# 5. Hand off to review (or to done, depending on the workflow)
agent-tasks tasks finish <task-id> \
  --result "Implemented X, tests green" \
  --pr-url https://github.com/acme/repo/pull/42

# 6. Later: pickup might return a review-claim, approve or request changes
agent-tasks tasks finish <reviewed-task-id> --outcome approve --result "LGTM"
```

## 2. Approve and auto-merge in one step

When the task workflow allows the reviewer to merge, combine `--outcome approve` with `--auto-merge`:

```bash
agent-tasks tasks finish <task-id> \
  --outcome approve \
  --result "LGTM, merging" \
  --auto-merge \
  --merge-method squash
```

`--auto-merge` is rejected when used with `--outcome request_changes` (the CLI surfaces this before hitting the network).

## 3. Request changes on a review claim

```bash
agent-tasks tasks finish <task-id> \
  --outcome request_changes \
  --result "Tests are missing for the error path. See inline comments."
```

This releases the review claim and routes the task back to the worker. The next `pickup` for the original worker will surface the rework as a `work` kind.

## 4. Abandon a claim without finishing

When you start a task and then realise you cannot complete it, release the claim cleanly so the next agent can pick it up:

```bash
agent-tasks tasks abandon <task-id>
```

This also works for review claims.

## 5. Bulk import via external references

`--external-ref` is an idempotency key. Re-running the same import does not create duplicates:

```bash
agent-tasks tasks create my-project \
  --title "Import from Jira: bug in checkout" \
  --priority HIGH \
  --external-ref "jira-PROJ-42" \
  --label imported --label backend
```

## 6. Scripted task processing

Combine `--quiet` and shell pipes to operate on lists:

```bash
# Acknowledge every unread signal
agent-tasks signals --quiet | xargs -n1 agent-tasks ack

# Get the IDs of every claimable task in a project
agent-tasks tasks list --json \
  | jq -r '.[] | select(.project.slug == "my-project") | .id'
```

## 7. Inspecting workflow gates

Before creating tasks against a project, check which gates apply:

```bash
agent-tasks projects effective-gates my-project
```

The output shows each gate, whether it is active, and the reason (project setting, workflow default, etc.).

## 8. Delegated PR creation

If the agent's environment does not have a GitHub token but a team member has granted `allowAgentPrCreate` consent, the agent can create the PR through agent-tasks itself:

```bash
agent-tasks github pr create \
  --task <task-id> \
  --owner LanNguyenSi --repo agent-tasks \
  --head feat/my-branch --base master \
  --title "feat: do the thing" \
  --body "Fixes the bug"
```

Same applies to `github pr merge` and `github pr comment`.
