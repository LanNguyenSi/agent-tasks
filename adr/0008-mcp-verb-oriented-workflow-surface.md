# ADR 0008: MCP als verb‑orientierte Workflow‑Façade (v2)

## Status
Accepted (2026-04-15)

## Context

Der MCP‑Server (`mcp-server/src/tools.ts`) exponiert heute 15 Tools, die fast 1:1 die REST‑API spiegeln:

```
projects_list
tasks_list, tasks_get, tasks_instructions, tasks_create,
tasks_claim, tasks_release, tasks_transition, tasks_update, tasks_comment
signals_poll, signals_ack
pull_requests_create, pull_requests_merge, pull_requests_comment
```

Der MCP ist damit ein generischer CRUD‑Wrapper über HTTP. Das hat in der täglichen Nutzung zu drei wiederkehrenden Problemen geführt:

1. **Zu viele Wahlmöglichkeiten für LLM‑Agents.** Welcher Status? `claim` vor oder nach `transition`? `instructions` lesen oder überspringen? Agents treffen falsche Entscheidungen oder lassen Schritte aus.
2. **Mehrfache Round‑Trips für eine logische Aktion.** Ein Task‑Start braucht heute `claim` → `get` → `instructions` → `transition(in_progress)` — vier Calls für eine atomare Intent‑Einheit.
3. **Ungültige Zustände sind ausdrückbar.** Da Agents `transition` mit beliebigen Zielen aufrufen können, produzieren sie regelmäßig Übergänge, die das Workflow‑Modell eigentlich verbietet.

Software‑Konsumenten (Frontend, `agent-tasks-cli`, externe Integrationen, Webhooks) brauchen die volle CRUD‑Oberfläche und sind deterministisch genug, um sie korrekt zu nutzen. LLM‑Agents brauchen weniger Optionen mit stärker geführten Semantiken. Die zwei Audiences sind nicht vereinbar in einer einzigen Oberfläche.

## Decision

Der MCP‑Server bekommt eine neue, **verb‑orientierte v2‑Oberfläche** mit 5 Tools plus einer Notluke. Sie ersetzt die 15 v1‑Tools für Agents. Die REST‑API bleibt unverändert vollständig — sie bedient weiterhin Frontend, CLI und Integrationen.

### v2 Tool‑Liste

| Tool | Ersetzt | Verhalten |
|---|---|---|
| `task_pickup` | `tasks_list(claimable)` + `signals_poll` + `projects_list` | Liefert das nächste Stück Arbeit: pending Signal, claimbarer Task (Work) **oder** reviewbarer Task (Review). Jedes Item ist mit `kind: "signal" \| "work" \| "review"` markiert. Signals werden implizit beim nächsten Pickup acked. |
| `task_start` | `tasks_claim` + `tasks_transition(in_progress)` + `tasks_get` + `tasks_instructions` + `review/claim` | Polymorph nach Task‑Status. Open → Author‑Claim + `in_progress`. Review → Review‑Claim. Response enthält Task‑Daten, DoD, Branch/PR‑Info, Blockers und `expectedFinishState`. |
| `task_note` | `tasks_comment` | Kommentar auf den aktuell geclaimten Task (Work oder Review). Keine `taskId` nötig. |
| `task_finish` | `tasks_transition(review/done)` + `tasks_release` + `review/release` + `pull_requests_*` | Polymorph nach Claim‑Art. Work: `{ result, prUrl? }` → `in_progress → review \| done`. Review: `{ result, outcome: "approve" \| "request_changes" }` → `review → done` oder `review → in_progress` mit reaktiviertem Author‑Claim. |
| `task_create` | `tasks_create` | Bleibt — distinkte Intent, schwer zu verstecken. |
| `task_abandon` *(Notluke)* | — | Selten, expliziter Bail‑Out. Released den aktiven Claim (Work oder Review) ohne `finish`, separater Intent für saubere Audit‑Trails. |

### Was wegfällt und warum

- `tasks_list`, `projects_list` — Browsing ist Frontend/Audit/CLI‑Sache, nicht Agent‑Sache.
- `tasks_get`, `tasks_instructions` — in `task_start` Response gefaltet. Ein Agent, der Instructions liest und nichts tut, ist kein Agent.
- `tasks_transition`, `tasks_update` — System besitzt Statuswechsel. Agents können keine ungültigen States mehr benennen, also auch keine produzieren.
- `signals_poll`, `signals_ack` — in `task_pickup` integriert, ack implizit.
- `pull_requests_create/merge/comment` — gehört nicht in agent-tasks. Agents nutzen `gh` direkt, Merge ist eine Human‑Entscheidung, PR‑URL ist Metadatum auf `task_finish`.
- Review‑Claim/Release‑Endpunkte werden nicht als separate Tools exponiert; `task_start` / `task_finish` decken Review über Polymorphie ab.

### Resolutions zu offenen Designfragen

**1. Workflow‑Variabilität bei `task_finish`.** Drei‑stufige Resolution:

1. Task hat `workflowId` → diesen Workflow nutzen
2. Sonst: Projekt hat `isDefault`‑Workflow → den nehmen
3. Sonst: Hardcoded Fallback → `done` (kein Review‑Step)

Bestehende Tasks ohne Workflow funktionieren weiter. `task_start` Response enthält `expectedFinishState: "done" | "review"`, damit der Agent die kommende Transition kennt.

**2. Mehrere parallele Claims.** Hard‑Limit auf 1 aktiven Claim pro Agent. `task_pickup` und `task_start` lehnen ab, wenn der Agent bereits einen Claim hält; Fehler‑Response enthält die existierende Claim‑ID und den Hinweis auf `task_finish` oder `task_abandon`. Parallelität wird über separate Agent‑Identitäten erreicht. Easier to relax later than to tighten.

**3. Backward‑Compatibility.** Beide Surfaces leben parallel im selben MCP‑Server für ein Deprecation‑Window von **4 Wochen** ab Merge. v1‑Tools bekommen `[DEPRECATED]`‑Prefix in der Description plus Verweis auf das v2‑Äquivalent. `agent-tasks-cli` migriert während des Windows direkt auf die REST‑API (er ist kein Agent und hat keinen Grund, über MCP zu gehen). Nach dem Sunset werden v1‑Tools komplett entfernt, nicht nur deprecated.

**4. PR‑Linking‑Semantik.** `task_finish` mit `prUrl` macht in v2.0 nur Format‑Validierung (Regex auf `github.com/.../pull/\d+`) und schreibt URL + Nummer in `Task.prUrl`/`Task.prNumber`. Kein synchroner GitHub‑API‑Call, keine Existenzprüfung, kein Status‑Sync. Async PR‑Status‑Sync via Webhook ist ein eigenständiges Follow‑up und nicht Teil dieser ADR.

**5. `task_pickup` Priority‑Logik.** Resolution‑Reihenfolge:

1. Pending Signals für diesen Agent (ältestes zuerst) → return mit `kind: "signal"`
2. Sonst: Tasks in Status `review` mit freiem Review‑Claim, deren Autor **nicht** dieser Agent ist, sortiert nach `priority DESC, createdAt ASC` → return mit `kind: "review"`
3. Sonst: claimbare Tasks (Status `open`) sortiert nach `priority DESC, createdAt ASC` → return mit `kind: "work"`
4. Filter: nur Tasks ohne offene `blockedBy`, nur aus autorisierten Projekten
5. Nichts da → `{ status: "idle" }`, kein Fehler

Review wird vor Work priorisiert, weil offene Reviews die Pipeline blockieren. Distinct‑Reviewer‑Regel bleibt hart durchgesetzt.

Skill‑Matching, Round‑Robin und konfigurierbare Sort‑Order sind explizit out of scope für v2.0.

**6. Review‑Flow: `request_changes` Semantik.** Bei `task_finish` mit `outcome: "request_changes"` auf einem Review‑Claim transitioniert der Task zurück zu `in_progress` und der ursprüngliche Author‑Claim wird reaktiviert. Der Autor‑Agent erhält ein Signal („review comments ready"), das beim nächsten `task_pickup` den Task zurückführt. Das hält den Kontext beim ursprünglichen Autor, statt den Task neu in den Claim‑Pool zu werfen und einen anderen Agent kalt einsteigen zu lassen.

## Consequences

**Positive:**

- Ein vollständiger Task‑Lifecycle braucht 4 Tool‑Calls statt 9–12 (`pickup` → `start` → `note` → `finish`)
- Agents können keine ungültigen Workflow‑States mehr benennen
- Audit‑Logs werden klarer (verb‑orientierte Intents statt CRUD‑Sequenzen)
- REST‑API bleibt unangetastet — kein Risiko für Frontend, CLI oder externe Integrationen
- Klare Audience‑Trennung: API für Software, MCP für Agents

**Negative / Trade‑offs:**

- Während des 4‑Wochen‑Deprecation‑Windows sind 21 Tools im MCP‑Listing sichtbar (15 v1 deprecated + 6 v2). Tokens kosten und visuell unschön, aber nötig für sicheren Cutover.
- `task_finish` ist „magic": der Agent sieht erst zur Laufzeit, ob das Ziel `review` oder `done` ist. Mitigation: `expectedFinishState` in der `task_start` Response.
- Hard‑Limit auf 1 Claim/Agent verhindert das legitime Szenario „Task A blockt auf CI, mach B in der Zwischenzeit". Mitigation: separate Agent‑Identität oder `task_abandon`.
- `agent-tasks-cli` muss migriert werden, bevor das Sunset greift — eine zusätzliche Arbeit ohne unmittelbaren User‑Value.
- Backend braucht mindestens zwei neue zusammengesetzte Endpunkte (`POST /tasks/pickup`, `POST /tasks/:id/start`) — der Rest ist Komposition über bestehende Routes (`review/claim`, `review/release`, `transition`, `release`, `comment`).
- Die Polymorphie von `task_start` und `task_finish` erfordert serverseitige Validierung basierend auf dem aktuellen Task‑Status bzw. aktiven Claim‑Typ — Fehler müssen klar kommunizieren, warum ein Aufruf abgelehnt wurde.

**Folge‑Aufgaben außerhalb dieser ADR:**

- Webhook‑basierter PR‑Status‑Sync (separater Task)
- Optionale v1‑Telemetrie zur Validierung der Happy‑Path‑Annahmen vor dem Sunset
- Frontend‑Banner auf Settings‑Seite muss MCP‑first statt Swagger‑Discovery erklären (Sub‑Task `29fd9041`)
- Update von `feedback_workflow.md` Memory nach Release
