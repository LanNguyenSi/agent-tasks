# Agent credentials for testing

This document explains how to obtain two distinct agent identities when writing
tests or running smoke checks that involve concurrent agent actors (e.g.
verifying that the claim CAS exclusion works correctly).

## Unit and integration tests (mocked Prisma)

In Vitest tests that mock `src/lib/prisma.js`, no real token lookup occurs.
Inject the actor directly into the Hono context with a pre-middleware:

```typescript
import type { AgentActor } from "../../src/types/auth.js";
import type { AppVariables } from "../../src/types/hono.js";
import { Hono } from "hono";
import { taskRouter } from "../../src/routes/tasks.js";

const AGENT_1: AgentActor = {
  type: "agent",
  tokenId: "local-1",         // arbitrary string; must differ between actors
  teamId: "team-x",
  userId: "user-x",
  scopes: ["tasks:read", "tasks:claim", "tasks:transition"],
};

const AGENT_2: AgentActor = {
  type: "agent",
  tokenId: "local-2",         // different tokenId simulates a second agent
  teamId: "team-x",
  userId: "user-x",
  scopes: ["tasks:read", "tasks:claim", "tasks:transition"],
};

function makeApp(actor: AgentActor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", taskRouter);
  return app;
}
```

The string `tokenId` values ("local-1", "local-2") act as the agent's identity
throughout the mocked handler — they are written into `claimedByAgentId` on the
task row and appear in audit events.  No database lookup takes place, so the
values do not need to match real rows.

## Smoke tests against a live backend

When running against a real backend (local dev or staging), create two tokens
via the REST API.  Both tokens must belong to the same team and carry the
required scopes.

### Prerequisites

- A valid user session cookie or a session-JWT Bearer token.
- A `teamId` you have admin access to.
- A `projectId` reachable by that team.

### Create the first agent token

```bash
curl -s -X POST http://localhost:3001/api/agent-tokens \
  -H "Content-Type: application/json" \
  -H "Cookie: <your-session-cookie>" \
  -d '{
    "name": "smoke-agent-1",
    "teamId": "<teamId>",
    "scopes": ["tasks:read", "tasks:claim", "tasks:transition"]
  }' | jq '{id: .token.id, token: .rawToken}'
```

Note the `rawToken` value — it is only shown once.  Store it as `TOKEN_1`.

### Create the second agent token

Repeat the same call with a different `name`:

```bash
curl -s -X POST http://localhost:3001/api/agent-tokens \
  -H "Content-Type: application/json" \
  -H "Cookie: <your-session-cookie>" \
  -d '{
    "name": "smoke-agent-2",
    "teamId": "<teamId>",
    "scopes": ["tasks:read", "tasks:claim", "tasks:transition"]
  }' | jq '{id: .token.id, token: .rawToken}'
```

Store that value as `TOKEN_2`.

### Fire a parallel-claim smoke check

```bash
TASK_ID="<your-task-id>"
BASE="http://localhost:3001"

(
  curl -s -o /tmp/out1.json -w "%{http_code}" \
    -X POST "$BASE/api/tasks/$TASK_ID/claim" \
    -H "Authorization: Bearer $TOKEN_1" &

  curl -s -o /tmp/out2.json -w "%{http_code}" \
    -X POST "$BASE/api/tasks/$TASK_ID/claim" \
    -H "Authorization: Bearer $TOKEN_2" &

  wait
)

echo "Response A:" && cat /tmp/out1.json | jq .
echo "Response B:" && cat /tmp/out2.json | jq .
```

Expect exactly one `200` (body contains `task.status: "in_progress"`) and one
`409` (body contains `error: "conflict"`).

### Required scopes

| Scope              | Enforced by `POST /tasks/:id/claim`? | Purpose                                        |
|--------------------|--------------------------------------|------------------------------------------------|
| `tasks:claim`      | Yes — missing → 403 before CAS write | Authorises the atomic claim write              |
| `tasks:read`       | No — conventional only               | Conventionally granted alongside `tasks:claim` |
| `tasks:transition` | No — conventional only               | Conventionally granted alongside `tasks:claim` |

`POST /tasks/:id/claim` checks **only** `tasks:claim`.  Tokens missing that
scope receive a `403 forbidden` before the CAS write.  `tasks:read` and
`tasks:transition` are not gated by this handler; they are included in the
example token creation calls by convention (most agents need all three scopes)
but their absence does not block the `/claim` path.
