# Webhook setup guide

How to connect GitHub webhook events to agent-tasks for automatic PR lifecycle sync.

**This is entirely optional.** Without webhooks, everything works manually — agents and humans claim tasks, set PR fields, and transition status themselves. Webhooks add automated timeline entries and status transitions.

## What you get

- **Activity timeline** — PR opened, review approved, changes requested, merged etc. appear in the task detail UI
- **Auto-transitions** — "changes requested" sends a task back to `in_progress`; PR merged moves it to `done`
- **PR binding** — tasks are matched to PRs via a 4-tier strategy: `prNumber` → `prUrl` → `branchName` → title pattern `[PR #N]`

See [review-automation-policy.md](review-automation-policy.md) for the full event → side-effect matrix.

## 1. GitHub App permissions

The GitHub App needs these **repository permissions**:

| Permission | Level | Why |
|---|---|---|
| Contents | Read & write | Push events, branch sync |
| Pull requests | Read & write | PR events, create PRs |
| Issues | Read & write | Issue lifecycle sync |
| Metadata | Read-only | Repo discovery |
| Workflows | Read & write | CI status |
| Administration | Read & write | Only if managing repo webhooks via API |

After changing permissions, the installation owner must **accept the new permissions** at `https://github.com/settings/installations` — look for the "review and accept" banner. Until accepted, new permissions are not active on installation tokens.

## 2. App-level webhook

Configure the webhook on the **GitHub App itself** (not per-repo). This covers all repositories where the app is installed — no per-repo setup needed.

In your GitHub App settings → General → Webhook:

| Field | Value |
|---|---|
| Active | Yes |
| Webhook URL | `https://your-domain.com/api/webhooks/github` |
| Content type | `application/json` |
| Secret | A random string (same as `GITHUB_WEBHOOK_SECRET` below) |
| SSL verification | Enable |

Under "Permissions & events" → "Subscribe to events", enable:
- **Pull request**
- **Pull request review**
- **Push**

**Why app-level instead of per-repo?** GitHub App installations on user-owned repos cannot manage webhooks via API (403). An app-level webhook covers all repos automatically and requires no per-repo configuration.

## 3. Server environment

Generate a webhook secret and configure the server:

```bash
# Generate secret
openssl rand -hex 32

# Add to server .env
GITHUB_WEBHOOK_SECRET=<the-generated-secret>

# Restart backend
docker compose -f docker-compose.prod.yml up -d backend
```

In development, `GITHUB_WEBHOOK_SECRET` can be left empty — the server accepts unsigned payloads in dev mode. In production, all unsigned payloads are rejected with 401.

## Event → side-effect matrix

| GitHub event | Precondition | Task transition | Timeline entry |
|---|---|---|---|
| `pull_request_review` (approved) | Task in `review` | None | "Review approved by {reviewer}" |
| `pull_request_review` (changes requested) | Task in `review` | `review → in_progress` | "Changes requested by {reviewer}" |
| `pull_request_review` (commented) | Any | None | "Review comment by {reviewer}" |
| `pull_request_review` (dismissed) | Any | None | "Review dismissed" |
| `pull_request` (merged) | Task not `done` | `* → done` | "PR merged by {user}" |
| `pull_request` (closed, no merge) | Any | None | "PR closed without merge" |
| `pull_request` (opened) | No existing task | Creates task in `review` | — |
| `pull_request` (opened) | Existing task found | Backfills prNumber/prUrl/branchName | "PR #N opened" |
| `push` | — | None | Updates project sync timestamp |

## Task ↔ PR binding

When a webhook event arrives, agent-tasks matches it to a task using this priority:

1. **`prNumber`** — strongest match, set by agents via `PATCH /api/tasks/:id`
2. **`prUrl`** — set by agents or backfilled from webhook
3. **`branchName`** — matches the PR's head branch (`head.ref`)
4. **`title pattern`** — legacy fallback, matches `[PR #N]` in task title

Results are deduplicated across all strategies. Only non-`done` tasks are returned.

**For reliable binding, agents should always set `prNumber` and `branchName` on their tasks.**

## Verifying the setup

After configuration, GitHub sends a `ping` event. Check deliveries:
- GitHub App settings → Advanced → Recent Deliveries
- Or via API: `GET /app/hook/deliveries` (requires JWT auth)

Create a test PR on a connected repo and verify:
1. A new task appears in agent-tasks with status `review`
2. The task has `prNumber`, `prUrl`, and `branchName` set
3. The Activity timeline in the task detail shows "PR #N opened"

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| 401 on webhook delivery | `GITHUB_WEBHOOK_SECRET` mismatch or not set | Ensure server env matches the secret in App settings |
| Events delivered but no task created | Project has no `githubRepo` set matching the repo | Set `githubRepo` on the project (e.g. `owner/repo`) |
| Delivery succeeds but no side effects | Event type not subscribed or action not handled | Check event subscriptions in App settings |
| 403 when creating repo-level webhooks | GitHub Apps can't manage hooks on user-owned repos | Use app-level webhook instead (this guide) |
| New permissions not working | Installation hasn't accepted updated permissions | Accept at github.com/settings/installations |
