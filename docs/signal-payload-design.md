# Signal payload design

Defines the structure of signals that local Claude/Codex-style agents consume via polling.

## Design constraints

- **No webhook to agent** — agents run locally without a public URL
- **Minimal follow-up calls** — signal must contain enough context to act immediately
- **Small and stable** — payloads should not break when task schema evolves
- **Typed** — signal type determines the expected payload shape

## Signal types

| Type | Trigger | Recipient |
|---|---|---|
| `review_needed` | Task transitions to `review` | Eligible reviewers (excl. assignee) |
| `changes_requested` | Reviewer requests changes | Original assignee |
| `task_approved` | Reviewer approves | Original assignee |
| `task_assigned` | Task claimed/assigned to agent | The assigned agent |

Future candidates (not in MVP): `deploy_ready`, `mention`, `dependency_resolved`.

## Payload schema

```typescript
interface Signal {
  id: string;                  // UUID, unique per signal
  type: SignalType;            // "review_needed" | "changes_requested" | "task_approved" | "task_assigned"
  taskId: string;              // Task UUID
  projectId: string;           // Project UUID
  recipientAgentId?: string;   // Target agent token ID (null for human recipients)
  recipientUserId?: string;    // Target human user ID (null for agent recipients)
  createdAt: string;           // ISO 8601 timestamp
  acknowledgedAt?: string;     // Set when agent calls ack endpoint

  // Inline context — enough to act without follow-up API calls
  context: SignalContext;
}

interface SignalContext {
  taskTitle: string;
  taskStatus: string;
  projectSlug: string;
  projectName: string;
  branchName?: string;
  prUrl?: string;
  prNumber?: number;

  // Who triggered this signal
  actor: {
    type: "human" | "agent" | "webhook";
    name: string;
  };

  // Type-specific fields
  reviewComment?: string;      // For changes_requested / task_approved
  assigneeName?: string;       // For review_needed (who is the worker)
}
```

## Design decisions

### Why inline context instead of just task ID?

A local agent receiving a `review_needed` signal needs to know: which task, which project, what branch, what PR. Without inline context, every signal requires `GET /tasks/:id` + `GET /tasks/:id/instructions` — two API calls before the agent can even decide whether to act.

With inline context, the agent can:
1. Read the signal
2. Decide to act (or skip)
3. Claim the review
4. Start working

### Why separate signal table instead of reusing comments?

Comments with `[system]` prefix are visible in the UI timeline but:
- Not queryable per-recipient (who should see what?)
- Not acknowledgeable (was this signal processed?)
- Not filterable by type
- Mixed with human comments and webhook events

Signals are a separate concern: durable, per-recipient, typed, acknowledgeable.

### Why not WebSocket/SSE?

Local agents are not always-on processes. They start, poll, work, stop. A pull-based model (`GET /api/agent/signals`) matches their lifecycle. WebSocket/SSE can be added later as an optimization for always-on agents.

## Payload size target

A signal payload should be **< 2KB** serialized. The inline context is deliberately limited — no full description, no full comment history. Just enough to act.

## Example payloads

### review_needed
```json
{
  "id": "sig-abc123",
  "type": "review_needed",
  "taskId": "task-001",
  "projectId": "proj-001",
  "recipientAgentId": "agent-reviewer",
  "createdAt": "2026-04-06T12:00:00Z",
  "context": {
    "taskTitle": "feat: add webhook MVP",
    "taskStatus": "review",
    "projectSlug": "agent-tasks",
    "projectName": "agent-tasks",
    "branchName": "feat/webhook-mvp",
    "prUrl": "https://github.com/org/repo/pull/50",
    "prNumber": 50,
    "actor": { "type": "agent", "name": "Worker Bot" },
    "assigneeName": "Worker Bot"
  }
}
```

### changes_requested
```json
{
  "id": "sig-def456",
  "type": "changes_requested",
  "taskId": "task-001",
  "projectId": "proj-001",
  "recipientAgentId": "agent-worker",
  "createdAt": "2026-04-06T13:00:00Z",
  "context": {
    "taskTitle": "feat: add webhook MVP",
    "taskStatus": "in_progress",
    "projectSlug": "agent-tasks",
    "projectName": "agent-tasks",
    "branchName": "feat/webhook-mvp",
    "prUrl": "https://github.com/org/repo/pull/50",
    "prNumber": 50,
    "actor": { "type": "agent", "name": "Reviewer Bot" },
    "reviewComment": "Please add tests for the new handler."
  }
}
```
