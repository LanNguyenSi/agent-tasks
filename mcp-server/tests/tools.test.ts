import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTools } from "../src/tools.js";
import { AgentTasksClient, AgentTasksApiError } from "../src/client.js";
import { serializeResult } from "../src/server.js";
import { WORKFLOW_PRIMER } from "../src/primer.js";
import { SIGNALS_DEFAULT_LIMIT, SIGNALS_BACKEND_FETCH_LIMIT } from "../src/read.js";

const __filename = fileURLToPath(import.meta.url);
const TOOLS_TS_SOURCE_PATH = resolve(__filename, "..", "..", "src", "tools.ts");

describe("buildTools", () => {
  const config = { baseUrl: "https://example.test", token: "tok_abc" };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function ok(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // Every test below exercises HANDLER behavior (wire format, receipts,
  // error mapping) via this helper, not registration. rc-v1-C007 gates a
  // subset of verbs out of the DEFAULT buildTools() result (tools.ts's
  // LEGACY_VERB_NAMES), but every handler stays fully defined regardless of
  // the flag (registration-time filter only, no handler deletion), so this
  // helper always builds in legacy mode: every verb name used anywhere in
  // this file stays reachable. The default-vs-legacy REGISTRATION list
  // itself is asserted separately, in its own describe block below, against
  // plain buildTools() calls (not this helper).
  function tool(name: string) {
    const tools = buildTools(new AgentTasksClient(config), { legacy: true });
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} not registered`);
    return t;
  }

  // Calling `tool(name).handler(rawArgs)` directly (as most tests in this
  // file do) bypasses the zod parsing step the real MCP SDK performs before
  // invoking the handler (McpServer.registerTool builds a zod object from
  // `inputShape` and parses incoming args against it, applying any
  // `.default()`s). Tests that specifically exercise a default value need
  // that parsing step, so run it explicitly here rather than asserting on
  // the raw, unparsed input.
  function parseArgs(name: string, raw: Record<string, unknown>) {
    return z.object(tool(name).inputShape).parse(raw);
  }

  // ── rc-v1-C007: default vs legacy registration ───────────────────────────
  //
  // buildTools() with no options (or { legacy: false }) registers only the
  // DEFAULT set: every verb still carrying tools.ts's DEPRECATED prefix is
  // pruned out UNLESS it is one of the four kept for a specific, documented
  // reason (tasks_get, upgraded into the v2 read surface; tasks_comment,
  // the receipt-converted alias; signals_poll / signals_ack, still the only
  // explicit signal-inbox surface). buildTools(client, { legacy: true })
  // registers the FULL pre-rc-v1-C007 set, unions of default + pruned,
  // unconditionally, so a caller still depending on a pruned verb's name
  // can opt back in (AGENT_TASKS_MCP_LEGACY=1 at the process entrypoint).
  // These three tests snapshot both lists and pin their relationship
  // mechanically, not just by inspection.

  const PRUNED_VERB_NAMES = [
    "projects_list",
    "projects_get",
    "tasks_list",
    "tasks_instructions",
    "tasks_create",
    "tasks_claim",
    "tasks_release",
    "tasks_transition",
    "tasks_update",
    "review_approve",
    "review_request_changes",
    "review_claim",
    "review_release",
    "pull_requests_comment",
  ];

  it("registers the default (non-legacy) verb set: rc-v1-C007's pruned v1 verbs are absent unless built with { legacy: true }", () => {
    const tools = buildTools(new AgentTasksClient(config));
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "project_tasks",
        "projects_get_effective_gates",
        "pull_requests_create",
        "pull_requests_merge",
        "signals_ack",
        "signals_poll",
        "task_abandon",
        "task_artifact_create",
        "task_artifact_get",
        "task_artifact_list",
        "task_attachment_get",
        "task_attachment_list",
        "task_create",
        "task_creator_abandon",
        "task_finish",
        "task_merge",
        "task_note",
        "task_pickup",
        "task_respec",
        "task_start",
        "task_submit_pr",
        "tasks_comment",
        "tasks_get",
        "workflow_primer",
      ].sort(),
    );
  });

  it("registers the full legacy verb set, exactly the pre-rc-v1-C007 registration, when built with { legacy: true }", () => {
    const tools = buildTools(new AgentTasksClient(config), { legacy: true });
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "project_tasks",
        "projects_get",
        "projects_get_effective_gates",
        "projects_list",
        "pull_requests_comment",
        "pull_requests_create",
        "pull_requests_merge",
        "review_approve",
        "review_claim",
        "review_release",
        "review_request_changes",
        "signals_ack",
        "signals_poll",
        "task_abandon",
        "task_artifact_create",
        "task_artifact_get",
        "task_artifact_list",
        "task_attachment_get",
        "task_attachment_list",
        "task_create",
        "task_creator_abandon",
        "task_finish",
        "task_merge",
        "task_note",
        "task_pickup",
        "task_respec",
        "task_start",
        "task_submit_pr",
        "tasks_claim",
        "tasks_comment",
        "tasks_create",
        "tasks_get",
        "tasks_instructions",
        "tasks_list",
        "tasks_release",
        "tasks_transition",
        "tasks_update",
        "workflow_primer",
      ].sort(),
    );
  });

  it("the legacy verb set is exactly the union of the default set and the pruned v1 verbs (no verb is silently added or dropped by the flag)", () => {
    const defaultNames = new Set(buildTools(new AgentTasksClient(config)).map((t) => t.name));
    const legacyNames = new Set(
      buildTools(new AgentTasksClient(config), { legacy: true }).map((t) => t.name),
    );
    for (const name of PRUNED_VERB_NAMES) {
      expect(defaultNames.has(name), `${name} should be pruned from the default set`).toBe(false);
      expect(legacyNames.has(name), `${name} should be present in the legacy set`).toBe(true);
    }
    expect(legacyNames).toEqual(new Set([...defaultNames, ...PRUNED_VERB_NAMES]));
  });

  // ── rc-v1-C007 fix round, item 6a: the [DEPRECATED marker must never
  // drift from LEGACY_VERB_NAMES again the way tasks_comment's did (it kept
  // carrying tools.ts's `[DEPRECATED, use v2 tools] ` prefix even though it
  // stayed in the DEFAULT registration, permanently -- a dishonest label on
  // a first-class alias). These two tests pin the marker/set relationship
  // mechanically in both directions, so this specific class of drift fails
  // here instead of only being caught by inspection. ──────────────────────
  it("the [DEPRECATED marker set (across all 38 tools, legacy mode) is exactly LEGACY_VERB_NAMES -- no verb carries the marker without being pruned, and no pruned verb is missing it", () => {
    const allTools = buildTools(new AgentTasksClient(config), { legacy: true });
    const markedNames = new Set(
      allTools.filter((t) => t.description.includes("[DEPRECATED")).map((t) => t.name),
    );
    expect(markedNames).toEqual(new Set(PRUNED_VERB_NAMES));
  });

  it("no DEFAULT-registered tool's description carries the [DEPRECATED marker", () => {
    const defaultTools = buildTools(new AgentTasksClient(config));
    const stillMarked = defaultTools
      .filter((t) => t.description.includes("[DEPRECATED"))
      .map((t) => t.name);
    expect(stillMarked).toEqual([]);
  });

  // ── rc-v1-C007 fix round, item 6c: structural invariant -- an allowedNext
  // reachable from a DEFAULT-registered verb must never name a legacy-only
  // one. errors.ts's preconditionFailedError is the one catalog entry whose
  // allowedNext is genuinely parameterized by the caller's own verbContext
  // (`retryVerb = verbContext ?? "task_finish"`); every wrap() call site in
  // tools.ts always passes its OWN tool's name as verbContext (never a
  // different tool's), so the invariant reduces to a source-level check:
  // no DEFAULT tool's own handler may pass a legacy-only verb name into
  // wrap()'s verbContext parameter. This is a source-parsing test, the same
  // idiom tests/primer.test.ts's `nonIncludeReshapingVerbNames` already
  // uses for tools.ts, chosen over replaying every backend error shape
  // through every default verb's real handler (which errors.test.ts's
  // per-case `assertAllowedNextRegistered` calls already do individually,
  // kept as-is -- this closes the gap those per-case assertions cannot:
  // a NEW wrap() call site added later that forgets this rule). ──────────
  it("no DEFAULT-registered tool's handler passes a legacy-only verb name as wrap()'s verbContext", () => {
    const source = readFileSync(TOOLS_TS_SOURCE_PATH, "utf8");
    const blocks = source.split(/\n {4}def\(\{/).slice(1);
    // Non-vacuity: the split must see every def({ in the file (see
    // primer.test.ts's identical guard on the same split pattern).
    expect(blocks.length).toBe((source.match(/def\(\{/g) ?? []).length);

    const defaultNames = new Set(buildTools(new AgentTasksClient(config)).map((t) => t.name));
    let verbContextSitesChecked = 0;
    for (const block of blocks) {
      const nameMatch = block.match(/name:\s*"([a-zA-Z_]+)"/);
      if (!nameMatch) continue;
      const toolName = nameMatch[1];
      if (!defaultNames.has(toolName)) continue; // legacy-only tool: out of scope for this invariant

      // wrap(<fn>, "verbContext") -- the fn argument may itself be a
      // multi-line arrow function, so this only anchors on the trailing
      // `, "literal")` immediately before wrap()'s own closing paren.
      const verbContextMatches = Array.from(block.matchAll(/wrap\([\s\S]*?,\s*"([a-zA-Z_]+)"\s*\)/g));
      for (const m of verbContextMatches) {
        verbContextSitesChecked++;
        expect(
          defaultNames.has(m[1]),
          `DEFAULT tool "${toolName}" passes verbContext "${m[1]}" to wrap(), which is not a DEFAULT-registered verb name`,
        ).toBe(true);
      }
    }
    // Non-vacuity: at least one DEFAULT tool actually passes a verbContext
    // (task_start and task_finish both do), or this test would pass having
    // checked nothing.
    expect(verbContextSitesChecked).toBeGreaterThan(0);
  });

  it("workflow_primer is parameterless and returns the deterministic long primer text verbatim", async () => {
    const t = tool("workflow_primer");
    expect(t.inputShape).toEqual({});
    const first = await t.handler({} as never);
    const second = await t.handler({} as never);
    expect(first).toBe(WORKFLOW_PRIMER);
    expect(second).toBe(WORKFLOW_PRIMER);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("task_attachment_list GETs the task attachments endpoint", async () => {
    fetchMock.mockResolvedValue(ok({ attachments: [] }));
    await tool("task_attachment_list").handler({
      taskId: "11111111-1111-1111-1111-111111111111",
    } as never);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/tasks/11111111-1111-1111-1111-111111111111/attachments");
    expect(init.method).toBe("GET");
  });

  it("task_attachment_get builds the content URL with includeBase64 + byte limits", async () => {
    fetchMock.mockResolvedValue(ok({ attachment: {}, content: { status: "ready" } }));
    await tool("task_attachment_get").handler({
      taskId: "11111111-1111-1111-1111-111111111111",
      attachmentId: "22222222-2222-2222-2222-222222222222",
      includeBase64: true,
      textByteLimit: 1000,
      base64ByteLimit: 2000,
    } as never);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(
      "/api/tasks/11111111-1111-1111-1111-111111111111/attachments/22222222-2222-2222-2222-222222222222/content",
    );
    expect(url).toContain("includeBase64=true");
    expect(url).toContain("textByteLimit=1000");
    expect(url).toContain("base64ByteLimit=2000");
    expect(init.method).toBe("GET");
  });

  it("task_attachment_get omits the query string when no options are set", async () => {
    fetchMock.mockResolvedValue(ok({ attachment: {}, content: { status: "ready" } }));
    await tool("task_attachment_get").handler({
      taskId: "11111111-1111-1111-1111-111111111111",
      attachmentId: "22222222-2222-2222-2222-222222222222",
    } as never);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://example.test/api/tasks/11111111-1111-1111-1111-111111111111/attachments/22222222-2222-2222-2222-222222222222/content",
    );
  });

  it("tasks_comment sends content field (not message) — matches backend createCommentSchema", async () => {
    fetchMock.mockResolvedValue(ok({ comment: { id: "c1" } }));
    await tool("tasks_comment").handler({
      taskId: "11111111-1111-1111-1111-111111111111",
      content: "progress update",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://example.test/api/tasks/11111111-1111-1111-1111-111111111111/comments",
    );
    expect(JSON.parse(init.body)).toEqual({ content: "progress update" });
  });

  it("tasks_create forwards externalRef and labels", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1" } }));
    await tool("tasks_create").handler({
      projectId: "22222222-2222-2222-2222-222222222222",
      title: "Imported task",
      externalRef: "jira-PROJ-42",
      labels: ["imported", "backend"],
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      title: "Imported task",
      externalRef: "jira-PROJ-42",
      labels: ["imported", "backend"],
    });
  });

  it("task_create forwards templateData to the backend create body", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1" } }));
    await tool("task_create").handler({
      projectId: "22222222-2222-2222-2222-222222222222",
      title: "Specced task",
      templateData: {
        goal: "ship it",
        acceptanceCriteria: "- tests green",
        agentPrompt: "Step 1: ...",
        prefers: { smallDiffs: true },
      },
    } as never);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://example.test/api/projects/22222222-2222-2222-2222-222222222222/tasks",
    );
    expect(JSON.parse(init.body)).toEqual({
      title: "Specced task",
      templateData: {
        goal: "ship it",
        acceptanceCriteria: "- tests green",
        agentPrompt: "Step 1: ...",
        prefers: { smallDiffs: true },
      },
    });
  });

  // ── task_respec ────────────────────────────────────────────────────

  it("task_respec POSTs description to /api/tasks/:id/respec and returns a receipt (bare confidence scalar, no echo)", async () => {
    fetchMock.mockResolvedValue(
      ok({
        task: { id: "t1", status: "open", description: "new desc" },
        confidence: {
          score: 80,
          threshold: 70,
          enforcementMode: "BLOCK",
          blocking: false,
          missing: [],
          findings: [],
          nextActions: [],
        },
      }),
    );
    const result = await tool("task_respec").handler({
      taskId: "11111111-1111-1111-1111-111111111111",
      description: "new desc",
    } as never);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://example.test/api/tasks/11111111-1111-1111-1111-111111111111/respec",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ description: "new desc" });
    // Receipt default: confidence is a bare scalar, score above threshold means
    // no deviation, and the sent description is never echoed back.
    expect(result).toEqual({ ok: true, task: { id: "t1", status: "open" }, confidence: 80 });
    expect(JSON.stringify(result)).not.toContain("new desc");
  });

  it("task_respec include:[\"task\"] returns the full pre-contract { task, confidence } object", async () => {
    const backendBody = {
      task: { id: "t1", status: "open", description: "new desc" },
      confidence: { score: 80, threshold: 70, enforcementMode: "BLOCK", blocking: false, missing: [], findings: [], nextActions: [] },
    };
    fetchMock.mockResolvedValue(ok(backendBody));
    const result = await tool("task_respec").handler({
      taskId: "11111111-1111-1111-1111-111111111111",
      description: "new desc",
      include: ["task"],
    } as never);
    expect(result).toEqual(backendBody);
  });

  it("task_respec receipt carries a CONFIDENCE_BELOW_THRESHOLD deviation when the re-scored value is still below threshold", async () => {
    fetchMock.mockResolvedValue(
      ok({
        task: { id: "t1", status: "open" },
        confidence: {
          score: 40,
          threshold: 60,
          enforcementMode: "BLOCK",
          blocking: true,
          missing: ["acceptanceCriteria"],
          findings: [],
          nextActions: [],
        },
      }),
    );
    const result = await tool("task_respec").handler({
      taskId: "22222222-2222-2222-2222-222222222222",
      description: "still thin",
    } as never);
    expect(result).toMatchObject({
      ok: true,
      task: { id: "t1", status: "open" },
      confidence: 40,
      deviations: [
        {
          code: "CONFIDENCE_BELOW_THRESHOLD",
          detail: { score: 40, threshold: 60, enforcementMode: "BLOCK", missing: ["acceptanceCriteria"] },
        },
      ],
    });
    const dev = (result as { deviations: { next?: string[] }[] }).deviations[0];
    expect(dev.next).toEqual(["task_respec to raise the score above the threshold"]);
  });

  it("task_respec POSTs templateData only (description omitted from body)", async () => {
    fetchMock.mockResolvedValue(
      ok({ task: { id: "t1" }, confidence: { score: 60 } }),
    );
    await tool("task_respec").handler({
      taskId: "22222222-2222-2222-2222-222222222222",
      templateData: { goal: "ship it" },
    } as never);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toEqual({ templateData: { goal: "ship it" } });
    expect(body).not.toHaveProperty("description");
  });

  it("task_respec forwards both description and templateData when both are provided", async () => {
    fetchMock.mockResolvedValue(
      ok({ task: { id: "t1" }, confidence: { score: 90 } }),
    );
    await tool("task_respec").handler({
      taskId: "33333333-3333-3333-3333-333333333333",
      description: "new desc",
      templateData: { goal: "ship it" },
    } as never);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      description: "new desc",
      templateData: { goal: "ship it" },
    });
  });

  it("task_respec rejects client-side when neither description nor templateData is provided (no HTTP call made)", async () => {
    await expect(
      tool("task_respec").handler({
        taskId: "44444444-4444-4444-4444-444444444444",
      } as never),
    ).rejects.toThrow(/at least one of description or templateData/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // rc-v1-C005: wrap() now maps every AgentTasksApiError through
  // errors.ts's mapBackendError and throws the serialized teaching-error
  // shape (see errors.test.ts for the dedicated unit tests on that mapping)
  // instead of the retired `agent-tasks API <status>: <message>` string.
  // These five tests keep proving wrap() is actually wired end-to-end from
  // a real handler call, just against the new shape.

  it("task_respec maps 409 (claimed/non-open task) to the respec_conflict catalog entry", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "conflict",
          message: "Task must be open and unclaimed to respec",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );
    let captured = "";
    try {
      await tool("task_respec").handler({
        taskId: "55555555-5555-5555-5555-555555555555",
        description: "new desc",
      } as never);
      throw new Error("expected a throw");
    } catch (e) {
      captured = e instanceof Error ? e.message : String(e);
    }
    const parsed = JSON.parse(captured);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("respec_conflict");
    expect(parsed.error.message).toBe("Task must be open and unclaimed to respec");
    expect(parsed.error.allowedNext).toEqual(["task_abandon", "task_respec"]);
  });

  // v1 backlog routing (AC4): wrap() end-to-end, task_start's own
  // backlog_not_promoted 403 and task_create's own backlog_routing_enforced
  // 400 map through mapBackendError to their catalog entries (dedicated
  // unit tests on the mapping itself live in errors.test.ts).

  it("task_start maps 403 (backlog task not yet promoted) to the backlog_not_promoted catalog entry", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "backlog_not_promoted",
          message: "This task is in backlog status and awaits operator promotion before an agent can start it.",
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    );
    let captured = "";
    try {
      await tool("task_start").handler({
        taskId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      } as never);
      throw new Error("expected a throw");
    } catch (e) {
      captured = e instanceof Error ? e.message : String(e);
    }
    const parsed = JSON.parse(captured);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("backlog_not_promoted");
    expect(parsed.error.allowedNext).toEqual(["task_respec", "task_creator_abandon"]);
  });

  it("task_create maps 400 (agent-supplied non-backlog status) to the backlog_routing_enforced catalog entry", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "backlog_routing_enforced",
          message: 'Agent-created tasks are routed to "backlog" status in v1 and cannot be created directly as "open".',
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    let captured = "";
    try {
      await tool("task_create").handler({
        projectId: "22222222-2222-2222-2222-222222222222",
        title: "Direct-status create",
        status: "open",
      } as never);
      throw new Error("expected a throw");
    } catch (e) {
      captured = e instanceof Error ? e.message : String(e);
    }
    const parsed = JSON.parse(captured);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("backlog_routing_enforced");
    expect(parsed.error.allowedNext).toEqual(["task_create"]);
  });

  it("task_respec maps 403 (non-creator, allowNonCreatorRespec unset) to the generic degrade shape (uncataloged code)", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "forbidden",
          message:
            "Only the task's creator can respec it (a project admin can set allowNonCreatorRespec to relax this)",
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    );
    let captured = "";
    try {
      await tool("task_respec").handler({
        taskId: "66666666-6666-6666-6666-666666666666",
        description: "new desc",
      } as never);
      throw new Error("expected a throw");
    } catch (e) {
      captured = e instanceof Error ? e.message : String(e);
    }
    const parsed = JSON.parse(captured);
    expect(parsed.error.code).toBe("forbidden");
    expect(parsed.error.message).toMatch(/creator/);
    expect(parsed.error.allowedNext).toEqual(["workflow_primer"]);
  });

  it("task_respec maps 400 (empty description/templateData rejected by backend) to the generic degrade shape", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: "bad_request", message: "description must not be empty" }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    let captured = "";
    try {
      await tool("task_respec").handler({
        taskId: "77777777-7777-7777-7777-777777777777",
        description: "   ",
      } as never);
      throw new Error("expected a throw");
    } catch (e) {
      captured = e instanceof Error ? e.message : String(e);
    }
    const parsed = JSON.parse(captured);
    expect(parsed.error.code).toBe("bad_request");
    expect(parsed.error.message).toBe("description must not be empty");
  });

  it("task_respec forwards an empty templateData object (client guard is presence-only) and maps the backend 400 to the generic degrade shape", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: "bad_request", message: "templateData must not be an empty object" }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    let captured = "";
    try {
      await tool("task_respec").handler({
        taskId: "99999999-9999-9999-9999-999999999999",
        templateData: {},
      } as never);
      throw new Error("expected a throw");
    } catch (e) {
      captured = e instanceof Error ? e.message : String(e);
    }
    const parsed = JSON.parse(captured);
    expect(parsed.error.code).toBe("bad_request");
    expect(parsed.error.message).toBe("templateData must not be an empty object");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("task_respec maps 404 (unknown task) to the generic degrade shape", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    let captured = "";
    try {
      await tool("task_respec").handler({
        taskId: "88888888-8888-8888-8888-888888888888",
        description: "new desc",
      } as never);
      throw new Error("expected a throw");
    } catch (e) {
      captured = e instanceof Error ? e.message : String(e);
    }
    const parsed = JSON.parse(captured);
    expect(parsed.error.code).toBe("http_404");
    expect(parsed.error.message).toBe("not found");
  });

  it("tasks_transition passes status and force fields", async () => {
    fetchMock.mockResolvedValue(ok({ task: { status: "done" } }));
    await tool("tasks_transition").handler({
      taskId: "33333333-3333-3333-3333-333333333333",
      status: "done",
      force: true,
      forceReason: "manual override",
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      status: "done",
      force: true,
      forceReason: "manual override",
    });
  });

  // rc-v1-C005 review round 1, finding #6: tasks_update accepts `result`
  // (same free-text field task_finish has) but used to skip the
  // pre-network structured-wrapper guard entirely. This proves the guard is
  // actually wired into tasks_update's own handler, not just into errors.ts's
  // pure resultMustBePlainStringError builder (see errors.test.ts for that).
  it("tasks_update rejects an XML-wrapped result locally, before any network call, naming tasks_update as the corrective", async () => {
    let captured = "";
    try {
      await tool("tasks_update").handler({
        taskId: "33333333-3333-3333-3333-333333333333",
        result: "<result>done</result>",
      } as never);
      throw new Error("expected a throw");
    } catch (e) {
      captured = e instanceof Error ? e.message : String(e);
    }
    const parsed = JSON.parse(captured);
    expect(parsed).toEqual({
      ok: false,
      error: {
        code: "result_not_plain_string",
        message: "result must be plain prose or markdown text, not wrapped in XML or JSON tags",
        recipe: "resubmit tasks_update with result as plain text (no <tag>...</tag> or {...} wrapping)",
        allowedNext: ["tasks_update"],
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tasks_update accepts ordinary prose/markdown result unchanged and still forwards it", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1" } }));
    await tool("tasks_update").handler({
      taskId: "33333333-3333-3333-3333-333333333333",
      result: "Implemented the feature; fixed the <Foo> component along the way.",
    } as never);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      result: "Implemented the feature; fixed the <Foo> component along the way.",
    });
  });

  // rc-v1-C005 round 2 review, finding #1 (MEDIUM): tasks_update's `result`
  // used to be an UNCAPPED z.string() -- symmetry with task_finish's own
  // result (which has always been .max(5000)) closes the gap that let an
  // arbitrarily large string reach looksLikeStructuredWrapper's tag-pair
  // scan in the first place. Exercised via the real zod schema (parseArgs),
  // not the handler directly, since the real MCP SDK validates inputShape
  // BEFORE the handler ever runs (see parseArgs's own comment above).
  it("tasks_update's zod schema rejects a result over 5000 chars (symmetry with task_finish's own cap)", () => {
    expect(() =>
      parseArgs("tasks_update", {
        taskId: "33333333-3333-3333-3333-333333333333",
        result: "x".repeat(5001),
      }),
    ).toThrow();
  });

  it("tasks_update's zod schema accepts a result at exactly the 5000-char cap", () => {
    expect(() =>
      parseArgs("tasks_update", {
        taskId: "33333333-3333-3333-3333-333333333333",
        result: "x".repeat(5000),
      }),
    ).not.toThrow();
  });

  // rc-v1-C005 review round 1, finding #7: pull_requests_create's own
  // cross_repo_pr_rejected emit site (backend/src/routes/github.ts's POST
  // /pull-requests) sends owner/repo, not a prUrl, so the default
  // task_submit_pr recipe misdirects it. Proves wrap()'s verbContext is
  // actually threaded through from this call site (errors.test.ts covers
  // the pure mapBackendError branch in isolation).
  it("pull_requests_create maps 400 cross_repo_pr_rejected to its OWN recipe (not task_submit_pr's)", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "cross_repo_pr_rejected",
          message: "PR points at other/repo, expected acme/agent-tasks.",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    let captured = "";
    try {
      await tool("pull_requests_create").handler({
        taskId: "55555555-5555-5555-5555-555555555555",
        owner: "other",
        repo: "repo",
        head: "feat/x",
        title: "PR title",
      } as never);
      throw new Error("expected a throw");
    } catch (e) {
      captured = e instanceof Error ? e.message : String(e);
    }
    const parsed = JSON.parse(captured);
    expect(parsed.error.code).toBe("cross_repo_pr_rejected");
    expect(parsed.error.recipe).toContain("pull_requests_create");
    expect(parsed.error.recipe).not.toContain("task_submit_pr");
    expect(parsed.error.allowedNext).toEqual(["pull_requests_create"]);
  });

  it("wrap translates an uncataloged AgentTasksApiError into the generic teaching-error shape (status-derived code)", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );
    let captured = "";
    try {
      await tool("tasks_claim").handler({
        taskId: "44444444-4444-4444-4444-444444444444",
      });
      throw new Error("expected a throw");
    } catch (e) {
      captured = e instanceof Error ? e.message : String(e);
    }
    const parsed = JSON.parse(captured);
    expect(parsed).toEqual({
      ok: false,
      error: {
        code: "http_403",
        message: "forbidden",
        recipe: "call workflow_primer for the full lifecycle reference and today's known traps",
        allowedNext: ["workflow_primer"],
      },
    });
  });

  it("unknown-tool guard: AgentTasksApiError is caught and rethrown, not leaked", async () => {
    fetchMock.mockRejectedValue(new TypeError("network down"));
    await expect(
      tool("projects_list").handler({} as never),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("does not put Bearer token in thrown error messages", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: "denied" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      await tool("tasks_claim").handler({
        taskId: "55555555-5555-5555-5555-555555555555",
      });
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain("tok_abc");
      expect(msg).not.toContain("Bearer");
    }
  });

  // Tell TypeScript the AgentTasksApiError symbol is used (for import side-effects).
  it("AgentTasksApiError is exported", () => {
    expect(AgentTasksApiError.name).toBe("AgentTasksApiError");
  });

  // ── GitHub PR tools ────────────────────────────────────────────────

  it("pull_requests_create POSTs the full body shape the backend expects", async () => {
    fetchMock.mockResolvedValue(
      ok({ pullRequest: { number: 42, url: "https://github.com/o/r/pull/42", title: "t" } }),
    );
    await tool("pull_requests_create").handler({
      taskId: "11111111-1111-1111-1111-111111111111",
      owner: "LanNguyenSi",
      repo: "agent-tasks",
      head: "feat/foo",
      base: "master",
      title: "feat: foo",
      body: "PR body",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/github/pull-requests");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      taskId: "11111111-1111-1111-1111-111111111111",
      owner: "LanNguyenSi",
      repo: "agent-tasks",
      head: "feat/foo",
      base: "master",
      title: "feat: foo",
      body: "PR body",
    });
  });

  it("pull_requests_create omits base when unset so backend default (main) applies", async () => {
    fetchMock.mockResolvedValue(ok({ pullRequest: { number: 1, url: "u", title: "t" } }));
    await tool("pull_requests_create").handler({
      taskId: "22222222-2222-2222-2222-222222222222",
      owner: "o",
      repo: "r",
      head: "b",
      title: "t",
    });
    const [, init] = fetchMock.mock.calls[0];
    const parsed = JSON.parse(init.body);
    expect(parsed).not.toHaveProperty("base");
    expect(parsed).not.toHaveProperty("body");
  });

  it("pull_requests_merge routes to /pull-requests/{prNumber}/merge and translates mergeMethod → merge_method", async () => {
    fetchMock.mockResolvedValue(ok({ merged: true, sha: "abc", message: "ok", task: { id: "t", status: "done" } }));
    await tool("pull_requests_merge").handler({
      taskId: "33333333-3333-3333-3333-333333333333",
      owner: "LanNguyenSi",
      repo: "agent-tasks",
      prNumber: 136,
      mergeMethod: "squash",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/github/pull-requests/136/merge");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.merge_method).toBe("squash");
    // Must NOT leak the camelCase variant into the wire format — the
    // backend's zod validator would silently drop it and fall back to
    // the default, which is subtle and wrong if the caller picked
    // "rebase".
    expect(body).not.toHaveProperty("mergeMethod");
    // prNumber goes in the URL, not the body.
    expect(body).not.toHaveProperty("prNumber");
    expect(body.taskId).toBe("33333333-3333-3333-3333-333333333333");
  });

  it("pull_requests_merge omits merge_method when mergeMethod unset so backend default (squash) applies", async () => {
    fetchMock.mockResolvedValue(ok({ merged: true, sha: null, message: "ok", task: { id: "t", status: "done" } }));
    await tool("pull_requests_merge").handler({
      taskId: "44444444-4444-4444-4444-444444444444",
      owner: "o",
      repo: "r",
      prNumber: 1,
    });
    const [, init] = fetchMock.mock.calls[0];
    const parsed = JSON.parse(init.body);
    expect(parsed).not.toHaveProperty("merge_method");
    expect(parsed).not.toHaveProperty("mergeMethod");
  });

  it("pull_requests_comment routes to /pull-requests/{prNumber}/comments and keeps body field", async () => {
    fetchMock.mockResolvedValue(ok({ comment: { id: "c1" } }));
    await tool("pull_requests_comment").handler({
      taskId: "55555555-5555-5555-5555-555555555555",
      owner: "LanNguyenSi",
      repo: "agent-tasks",
      prNumber: 136,
      body: "CI green, merging now.",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/github/pull-requests/136/comments");
    expect(init.method).toBe("POST");
    const parsed = JSON.parse(init.body);
    expect(parsed).toEqual({
      taskId: "55555555-5555-5555-5555-555555555555",
      owner: "LanNguyenSi",
      repo: "agent-tasks",
      body: "CI green, merging now.",
    });
    expect(parsed).not.toHaveProperty("prNumber");
  });

  // ── projects_get ───────────────────────────────────────────────────

  it("projects_get routes UUIDs to /api/projects/:id", async () => {
    fetchMock.mockResolvedValue(ok({ project: { id: "77777777-7777-7777-7777-777777777777" } }));
    await tool("projects_get").handler({
      slugOrId: "77777777-7777-7777-7777-777777777777",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://example.test/api/projects/77777777-7777-7777-7777-777777777777",
    );
    expect(init.method).toBe("GET");
  });

  it("projects_get routes slugs to /api/projects/by-slug/:slug and URL-encodes them", async () => {
    fetchMock.mockResolvedValue(ok({ project: { slug: "agent tasks" } }));
    await tool("projects_get").handler({ slugOrId: "agent tasks" });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/projects/by-slug/agent%20tasks");
  });

  // ── project_tasks ──────────────────────────────────────────────────

  it("project_tasks accepts a slug and forwards filters to GET /projects/:id/tasks", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ project: { id: "p1" } }))
      .mockResolvedValueOnce(ok({ tasks: [] }));
    await tool("project_tasks").handler({
      project: "agent-tasks",
      status: ["open"],
      priority: "HIGH",
      labels: ["mcp", "dx"],
      unclaimed: true,
      limit: 25,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://example.test/api/projects/by-slug/agent-tasks",
    );
    const url = fetchMock.mock.calls[1][0] as string;
    expect(url.startsWith("https://example.test/api/projects/p1/tasks?")).toBe(true);
    expect(url).toContain("status=open");
    expect(url).toContain("priority=HIGH");
    expect(url).toContain("labels=mcp%2Cdx");
    expect(url).toContain("unclaimed=true");
    expect(url).toContain("limit=25");
  });

  // v1 backlog routing: project_tasks's status filter accepts "backlog" and
  // forwards it end-to-end through the mcp-server layer (zod input parse ->
  // client -> backend request). task 3653962f: project_tasks now projects
  // every row to a summary by default (see the "returns summary rows"
  // describe block below), but this fixture carries no field outside the
  // summary's own set (id/title/status), so the row happens to round-trip
  // unchanged -- coincidence of this fixture's shape, not evidence the
  // projection is skipped (see the dedicated summary-shape tests below for
  // that).
  it("project_tasks filters on status: 'backlog' end-to-end and returns backlog tasks unmodified", async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ tasks: [{ id: "t1", status: "backlog", title: "drafted by an agent" }], nextCursor: null }),
    );
    const parsed = parseArgs("project_tasks", {
      project: "00000000-0000-0000-0000-000000000001",
      status: "backlog",
    });
    const result = await tool("project_tasks").handler(parsed);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("status=backlog");
    expect(result).toEqual({ tasks: [{ id: "t1", status: "backlog", title: "drafted by an agent" }], nextCursor: null });
  });

  it("project_tasks skips the slug round-trip when given a UUID", async () => {
    fetchMock.mockResolvedValueOnce(ok({ tasks: [] }));
    await tool("project_tasks").handler({
      project: "00000000-0000-0000-0000-000000000001",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://example.test/api/projects/00000000-0000-0000-0000-000000000001/tasks",
    );
  });

  // ── R1 review, F3: project_tasks's `project` now shares projectSlug's
  // input hygiene (.trim().min(1).max(255)) instead of the bare
  // z.string().min(1) it shipped with -- a whitespace-padded slug now
  // trims and resolves instead of 404ing on the untrimmed value.
  it("project_tasks trims a whitespace-padded project slug before resolving", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ project: { id: "p1" } }))
      .mockResolvedValueOnce(ok({ tasks: [] }));
    const parsed = parseArgs("project_tasks", { project: "agent-tasks " });
    expect(parsed.project).toBe("agent-tasks");
    await tool("project_tasks").handler(parsed);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://example.test/api/projects/by-slug/agent-tasks",
    );
  });

  // ── project_tasks / tasks_list — sort default + cursor (task 14c947a7) ──
  //
  // Both tools expose `sort`/`cursor`. `project_tasks` defaults its zod
  // `sort` field to `createdAt:desc`, matching the backend route's own
  // pre-existing default (documented, not a behavior change). `tasks_list`
  // ALSO defaults to `createdAt:desc` at the tool layer even though the
  // backend `/tasks/claimable` route itself still defaults to `createdAt:asc`
  // for API-level backward compatibility — the override exists so an agent
  // calling tasks_list with no `sort` sees the N newest tasks, not the
  // oldest (the bug this task fixes).

  it("project_tasks zod-defaults sort to createdAt:desc when the caller omits it", () => {
    const parsed = parseArgs("project_tasks", {
      project: "00000000-0000-0000-0000-000000000001",
    });
    expect(parsed.sort).toBe("createdAt:desc");
  });

  it("project_tasks forwards an explicit sort override and cursor to GET /projects/:id/tasks", async () => {
    fetchMock.mockResolvedValueOnce(ok({ tasks: [], nextCursor: null }));
    const parsed = parseArgs("project_tasks", {
      project: "00000000-0000-0000-0000-000000000001",
      sort: "createdAt:asc",
      cursor: "task-7",
    });
    await tool("project_tasks").handler(parsed);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("sort=createdAt%3Aasc");
    expect(url).toContain("cursor=task-7");
  });

  it("tasks_list zod-defaults sort to createdAt:desc when the caller omits it", () => {
    const parsed = parseArgs("tasks_list", {});
    expect(parsed.sort).toBe("createdAt:desc");
  });

  it("tasks_list forwards the defaulted sort to GET /tasks/claimable", async () => {
    fetchMock.mockResolvedValue(ok({ tasks: [], nextCursor: null }));
    const parsed = parseArgs("tasks_list", {});
    await tool("tasks_list").handler(parsed);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("sort=createdAt%3Adesc");
  });

  it("tasks_list forwards an explicit sort override and cursor", async () => {
    fetchMock.mockResolvedValue(ok({ tasks: [], nextCursor: null }));
    const parsed = parseArgs("tasks_list", { sort: "createdAt:asc", cursor: "task-9" });
    await tool("tasks_list").handler(parsed);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("sort=createdAt%3Aasc");
    expect(url).toContain("cursor=task-9");
  });

  // ── review_* ───────────────────────────────────────────────────────

  it("review_approve POSTs action=approve with optional comment", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1", status: "done" } }));
    await tool("review_approve").handler({
      taskId: "11111111-1111-1111-1111-111111111111",
      comment: "lgtm",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://example.test/api/tasks/11111111-1111-1111-1111-111111111111/review",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ action: "approve", comment: "lgtm" });
  });

  it("review_request_changes POSTs action=request_changes", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1", status: "in_progress" } }));
    await tool("review_request_changes").handler({
      taskId: "22222222-2222-2222-2222-222222222222",
      comment: "please split the diff",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://example.test/api/tasks/22222222-2222-2222-2222-222222222222/review",
    );
    expect(JSON.parse(init.body)).toEqual({
      action: "request_changes",
      comment: "please split the diff",
    });
  });

  it("review_claim POSTs to /review/claim with no body", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1" } }));
    await tool("review_claim").handler({
      taskId: "33333333-3333-3333-3333-333333333333",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://example.test/api/tasks/33333333-3333-3333-3333-333333333333/review/claim",
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("review_release POSTs to /review/release", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1" } }));
    await tool("review_release").handler({
      taskId: "44444444-4444-4444-4444-444444444444",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://example.test/api/tasks/44444444-4444-4444-4444-444444444444/review/release",
    );
    expect(init.method).toBe("POST");
  });

  // ── task_pickup reclassify ──────────────────────────────────────────

  it("task_pickup appends ?reclassify=true when reclassify=true", async () => {
    fetchMock.mockResolvedValue(ok({ kind: "idle" }));
    await tool("task_pickup").handler({ reclassify: true } as never);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/tasks/pickup?reclassify=true");
    expect(init.method).toBe("POST");
  });

  it("task_pickup omits the reclassify query param when reclassify is not passed", async () => {
    fetchMock.mockResolvedValue(ok({ kind: "idle" }));
    await tool("task_pickup").handler({} as never);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/tasks/pickup");
    expect(url).not.toContain("reclassify");
  });

  it("task_pickup omits the reclassify query param when reclassify=false", async () => {
    fetchMock.mockResolvedValue(ok({ kind: "idle" }));
    await tool("task_pickup").handler({ reclassify: false } as never);
    const [url] = fetchMock.mock.calls[0];
    // Backend only honours the literal "?reclassify=true"; false means opt-out so we skip the param.
    expect(url).toBe("https://example.test/api/tasks/pickup");
  });

  // ── task_start reclassify ───────────────────────────────────────────

  it("task_start forwards reclassify as a JSON boolean in the request body", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1" } }));
    await tool("task_start").handler({
      taskId: "11111111-1111-1111-1111-111111111111",
      reclassify: true,
    } as never);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://example.test/api/tasks/11111111-1111-1111-1111-111111111111/start",
    );
    expect(JSON.parse(init.body)).toEqual({ reclassify: true });
  });

  it("task_start forwards both branchName and reclassify in a single body", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1" } }));
    await tool("task_start").handler({
      taskId: "11111111-1111-1111-1111-111111111111",
      branchName: "feat/my-branch",
      reclassify: true,
    } as never);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      branchName: "feat/my-branch",
      reclassify: true,
    });
  });

  it("task_start omits body when neither branchName nor reclassify are passed", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1" } }));
    await tool("task_start").handler({
      taskId: "22222222-2222-2222-2222-222222222222",
    } as never);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBeUndefined();
  });

  it("task_start omits reclassify from body when not provided but branchName is", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1" } }));
    await tool("task_start").handler({
      taskId: "33333333-3333-3333-3333-333333333333",
      branchName: "feat/only-branch",
    } as never);
    const [, init] = fetchMock.mock.calls[0];
    const parsed = JSON.parse(init.body);
    expect(parsed).toEqual({ branchName: "feat/only-branch" });
    expect(parsed).not.toHaveProperty("reclassify");
  });

  it("task_start sends reclassify:false in the body when explicitly set to false (no-op on backend; documents start-vs-pickup asymmetry)", async () => {
    // task_pickup omits ?reclassify entirely for false; task_start sends the
    // JSON boolean because the backend schema is z.boolean().optional() and
    // false is a valid value (evaluates as !== true, so it is a backend no-op).
    fetchMock.mockResolvedValue(ok({ task: { id: "t1" } }));
    await tool("task_start").handler({
      taskId: "44444444-4444-4444-4444-444444444444",
      reclassify: false,
    } as never);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ reclassify: false });
  });

  it("pull_requests_merge propagates a 403 delegation-missing error through wrap as the generic degrade shape", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "forbidden",
          message:
            "No authorized user for GitHub delegation. A team member must connect GitHub and enable 'Allow agents to merge PRs' in Settings.",
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    );
    let captured = "";
    try {
      await tool("pull_requests_merge").handler({
        taskId: "66666666-6666-6666-6666-666666666666",
        owner: "o",
        repo: "r",
        prNumber: 7,
      });
      throw new Error("expected a throw");
    } catch (e) {
      captured = e instanceof Error ? e.message : String(e);
    }
    const parsed = JSON.parse(captured);
    expect(parsed.error.code).toBe("forbidden");
    expect(parsed.error.message).toMatch(/delegation/);
  });

  // ── Receipt layer wiring (rc-v1-C002) ────────────────────────────────
  //
  // receipt.ts owns the projection logic and has its own dedicated unit
  // tests (tests/receipt.test.ts). These tests only prove the handler
  // wiring in tools.ts: receipt-by-default, the include:["task"] valve
  // bypassing the projection, and no-echo end to end through a real
  // handler call (not just the pure builder).

  const TASK_ID = "11111111-1111-1111-1111-111111111111";

  it("task_create returns a receipt by default and never echoes description/templateData", async () => {
    fetchMock.mockResolvedValue(
      ok({
        task: {
          id: "t1",
          status: "open",
          description: "SECRET DESCRIPTION",
          templateData: { goal: "SECRET GOAL TEXT" },
          labels: [],
        },
        confidence: { score: 90, threshold: 60, enforcementMode: "BLOCK", blocking: false, missing: [], findings: [], nextActions: [] },
      }),
    );
    const result = await tool("task_create").handler({
      projectId: "22222222-2222-2222-2222-222222222222",
      title: "Specced task",
      description: "SECRET DESCRIPTION",
      templateData: { goal: "SECRET GOAL TEXT" },
    } as never);
    expect(result).toEqual({
      ok: true,
      task: { id: "t1", status: "open" },
      confidence: 90,
      next: ["task_start to begin work on this task"],
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  // v1 backlog routing (AC3): an agent-created task's receipt surfaces
  // status: "backlog" (task.status, not a bespoke field) and its next hint
  // names operator promotion instead of task_start.
  it("task_create's receipt shows status: 'backlog' and an 'awaits operator promotion' next hint for an agent-created task", async () => {
    fetchMock.mockResolvedValue(
      ok({
        task: { id: "t1", status: "backlog", labels: [] },
        confidence: { score: 90, threshold: 60, enforcementMode: "BLOCK", blocking: false, missing: [], findings: [], nextActions: [] },
      }),
    );
    const result = await tool("task_create").handler({
      projectId: "22222222-2222-2222-2222-222222222222",
      title: "Drafted by an agent",
    } as never);
    expect(result).toEqual({
      ok: true,
      task: { id: "t1", status: "backlog" },
      confidence: 90,
      next: ["awaits operator promotion; task_start rejects a backlog task until an operator promotes it to open"],
    });
  });

  it("task_create include:[\"task\"] returns the full pre-contract { task, confidence } object", async () => {
    const backendBody = {
      task: { id: "t1", status: "open", description: "d" },
      confidence: { score: 90, threshold: 60, enforcementMode: "BLOCK", blocking: false, missing: [], findings: [], nextActions: [] },
    };
    fetchMock.mockResolvedValue(ok(backendBody));
    const result = await tool("task_create").handler({
      projectId: "22222222-2222-2222-2222-222222222222",
      title: "Specced task",
      include: ["task"],
    } as never);
    expect(result).toEqual(backendBody);
  });

  it("task_finish returns a receipt by default and never echoes the result text", async () => {
    fetchMock.mockResolvedValue(
      ok({ kind: "work", task: { id: "t1", status: "review" }, targetStatus: "review" }),
    );
    const result = await tool("task_finish").handler({
      taskId: TASK_ID,
      result: "SECRET PROGRESS NOTES",
    } as never);
    expect(result).toEqual({ ok: true, task: { id: "t1", status: "review" } });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("task_finish include:[\"task\"] returns the full backend object", async () => {
    const backendBody = { kind: "work", task: { id: "t1", status: "review" }, targetStatus: "review" };
    fetchMock.mockResolvedValue(ok(backendBody));
    const result = await tool("task_finish").handler({ taskId: TASK_ID, include: ["task"] } as never);
    expect(result).toEqual(backendBody);
  });

  // rc-v1-C005 catalog entry #8 (errors.ts's resultMustBePlainStringError):
  // the backend performs no validation of `result`'s shape at all, so this
  // guard fires entirely at this layer, BEFORE any request is sent.
  it("task_finish rejects an XML-wrapped result locally, before any network call", async () => {
    let captured = "";
    try {
      await tool("task_finish").handler({
        taskId: TASK_ID,
        result: "<result>done</result>",
      } as never);
      throw new Error("expected a throw");
    } catch (e) {
      captured = e instanceof Error ? e.message : String(e);
    }
    const parsed = JSON.parse(captured);
    expect(parsed).toEqual({
      ok: false,
      error: {
        code: "result_not_plain_string",
        message: "result must be plain prose or markdown text, not wrapped in XML or JSON tags",
        recipe: "resubmit task_finish with result as plain text (no <tag>...</tag> or {...} wrapping)",
        allowedNext: ["task_finish"],
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("task_finish rejects a whole-string-JSON result locally, before any network call", async () => {
    await expect(
      tool("task_finish").handler({
        taskId: TASK_ID,
        result: '{"summary":"done"}',
      } as never),
    ).rejects.toThrow(/result_not_plain_string/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("task_finish accepts ordinary prose/markdown result unchanged", async () => {
    fetchMock.mockResolvedValue(
      ok({ kind: "work", task: { id: "t1", status: "review" }, targetStatus: "review" }),
    );
    await tool("task_finish").handler({
      taskId: TASK_ID,
      result: "Implemented the feature; fixed the <Foo> component along the way.",
    } as never);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("task_submit_pr returns a receipt by default and never echoes branchName/prUrl", async () => {
    fetchMock.mockResolvedValue(
      ok({ kind: "submit_pr", task: { id: "t1", status: "in_progress" } }),
    );
    const result = await tool("task_submit_pr").handler({
      taskId: TASK_ID,
      branchName: "feat/secret-branch-name",
      prUrl: "https://github.com/o/r/pull/1",
      prNumber: 1,
    } as never);
    expect(result).toEqual({
      ok: true,
      task: { id: "t1", status: "in_progress" },
      next: ["task_finish once CI is green"],
    });
    expect(JSON.stringify(result)).not.toContain("secret-branch-name");
  });

  it("task_note returns a receipt with task.id only (no status field) and never echoes content", async () => {
    fetchMock.mockResolvedValue(ok({ comment: { id: "c1", taskId: "t1", content: "SECRET NOTE" } }));
    const result = await tool("task_note").handler({ taskId: TASK_ID, content: "SECRET NOTE" } as never);
    expect(result).toEqual({ ok: true, task: { id: "t1" } });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("tasks_comment (deprecated v1 alias) returns the same receipt shape as task_note", async () => {
    fetchMock.mockResolvedValue(ok({ comment: { id: "c1", taskId: "t1" } }));
    const result = await tool("tasks_comment").handler({ taskId: TASK_ID, content: "progress" } as never);
    expect(result).toEqual({ ok: true, task: { id: "t1" } });
  });

  it("task_merge returns a receipt with task status but no transition field by default (transition would be fabricated: alreadyMerged describes the GitHub PR, not the task's prior DB state)", async () => {
    fetchMock.mockResolvedValue(
      ok({ task: { id: "t1", status: "done" }, merged: true, sha: "abc123", alreadyMerged: false }),
    );
    const result = await tool("task_merge").handler({ taskId: TASK_ID } as never);
    expect(result).toEqual({
      ok: true,
      task: { id: "t1", status: "done" },
    });
    expect(result).not.toHaveProperty("transition");
  });

  it("task_merge receipt carries no transition field even on an idempotent already-merged retry", async () => {
    fetchMock.mockResolvedValue(
      ok({ task: { id: "t1", status: "done" }, merged: true, sha: "abc123", alreadyMerged: true }),
    );
    const result = await tool("task_merge").handler({ taskId: TASK_ID } as never);
    expect(result).toEqual({
      ok: true,
      task: { id: "t1", status: "done" },
    });
    expect(result).not.toHaveProperty("transition");
  });

  it("task_merge include:[\"task\"] returns the full { task, merged, sha, alreadyMerged } object", async () => {
    const backendBody = { task: { id: "t1", status: "done" }, merged: true, sha: "abc123", alreadyMerged: false };
    fetchMock.mockResolvedValue(ok(backendBody));
    const result = await tool("task_merge").handler({ taskId: TASK_ID, include: ["task"] } as never);
    expect(result).toEqual(backendBody);
  });

  it("task_abandon returns a receipt by default", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1", status: "open" } }));
    const result = await tool("task_abandon").handler({ taskId: TASK_ID } as never);
    expect(result).toEqual({ ok: true, task: { id: "t1", status: "open" } });
  });

  it("task_abandon include:[\"task\"] returns the full backend object", async () => {
    const backendBody = { task: { id: "t1", status: "open" } };
    fetchMock.mockResolvedValue(ok(backendBody));
    const result = await tool("task_abandon").handler({ taskId: TASK_ID, include: ["task"] } as never);
    expect(result).toEqual(backendBody);
  });

  // task 7a1360da follow-up (batch 19 round 2 review): task_creator_abandon
  // had no handler-level test at all -- everything below exercises only the
  // backend route. Mirrors the task_abandon pair above, plus the "no
  // reason" wire-format check the backend's own test suite already covers
  // server-side (tasks-v2-routes.test.ts's "works with no body at all").
  it("task_creator_abandon calls POST .../creator-abandon with taskId, omits the body entirely when reason is not given, and returns an abandon receipt", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "t1", status: "abandoned" } }));
    const result = await tool("task_creator_abandon").handler({ taskId: TASK_ID } as never);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://example.test/api/tasks/${TASK_ID}/creator-abandon`);
    expect(init.method).toBe("POST");
    // client.ts's request() only sets body/Content-Type when input !==
    // undefined; tools.ts's handler passes `reason !== undefined ? {
    // reason } : undefined`, so a call with no reason must reach fetch with
    // no body at all, not `{}` or `{ reason: undefined }`.
    expect(init.body).toBeUndefined();
    expect(init.headers).not.toHaveProperty("Content-Type");
    expect(result).toEqual({ ok: true, task: { id: "t1", status: "abandoned" } });
  });

  it("task_creator_abandon include:[\"task\"] returns the full backend object", async () => {
    const backendBody = { task: { id: "t1", status: "abandoned" } };
    fetchMock.mockResolvedValue(ok(backendBody));
    const result = await tool("task_creator_abandon").handler({
      taskId: TASK_ID,
      include: ["task"],
    } as never);
    expect(result).toEqual(backendBody);
  });

  // Shared fixture for the two loops below: one entry per converted write
  // verb, its happy-path call args, and the mocked backend body. Both the
  // receipt-budget loop and the include:["task"] bypass loop drive off this
  // same list so the two stay in sync as verbs are added.
  const writeVerbCases: Array<{ tool: string; args: Record<string, unknown>; body: unknown }> = [
    {
      tool: "task_create",
      args: { projectId: "22222222-2222-2222-2222-222222222222", title: "t" },
      body: { task: { id: "t1", status: "open" }, confidence: { score: 90, threshold: 60, enforcementMode: "BLOCK", blocking: false, missing: [], findings: [], nextActions: [] } },
    },
    {
      tool: "task_respec",
      args: { taskId: TASK_ID, description: "d" },
      body: { task: { id: "t1", status: "open" }, confidence: { score: 90, threshold: 60, enforcementMode: "BLOCK", blocking: false, missing: [], findings: [], nextActions: [] } },
    },
    { tool: "task_finish", args: { taskId: TASK_ID }, body: { kind: "work", task: { id: "t1", status: "review" }, targetStatus: "review" } },
    {
      tool: "task_submit_pr",
      args: { taskId: TASK_ID, branchName: "b", prUrl: "https://github.com/o/r/pull/1", prNumber: 1 },
      body: { kind: "submit_pr", task: { id: "t1", status: "in_progress" } },
    },
    { tool: "task_note", args: { taskId: TASK_ID, content: "c" }, body: { comment: { id: "c1", taskId: "t1" } } },
    { tool: "tasks_comment", args: { taskId: TASK_ID, content: "c" }, body: { comment: { id: "c1", taskId: "t1" } } },
    { tool: "task_merge", args: { taskId: TASK_ID }, body: { task: { id: "t1", status: "done" }, merged: true, sha: "abc", alreadyMerged: false } },
    { tool: "task_abandon", args: { taskId: TASK_ID }, body: { task: { id: "t1", status: "open" } } },
  ];

  it("every converted write verb's happy-path receipt serializes within the tier-1 budget (~240 chars / ~60 tokens)", async () => {
    // Measured through serializeResult (server.ts): the exact
    // JSON.stringify(x, null, 2) transform the MCP server applies to the
    // handler's return value before it goes out as the tool's text block. A
    // compact JSON.stringify(result) here would under-measure the real wire
    // payload and let a budget regression pass unnoticed.
    for (const { tool: name, args, body } of writeVerbCases) {
      fetchMock.mockResolvedValue(ok(body));
      const result = await tool(name).handler(args as never);
      expect(serializeResult(result).length, `${name} happy-path receipt`).toBeLessThanOrEqual(240);
    }
  });

  it("every converted write verb's include:[\"task\"] call bypasses the receipt and returns the raw backend body", async () => {
    for (const { tool: name, args, body } of writeVerbCases) {
      fetchMock.mockResolvedValue(ok(body));
      const result = await tool(name).handler({ ...args, include: ["task"] } as never);
      expect(result, `${name} include:["task"]`).toEqual(body);
    }
  });

  // Schema-level regression coverage for the write/read `include` narrowing
  // (docs/response-contract-v1.md's "include semantics" section): today the
  // write verbs' includeSchema accepts only ["task"], the read-verb
  // vocabulary ("description", "comments", "instructions", "artifacts")
  // belongs to rc-v1-C006 and MUST be a validation error on a write verb,
  // not a silent no-op. Asserted at the zod schema level (not just via the
  // handler) so re-widening the enum back to the full vocabulary fails this
  // test even if every handler-level test stays green.
  it("write verbs' include schema rejects the read-verb vocabulary and accepts \"task\"", () => {
    for (const { tool: name, args } of writeVerbCases) {
      const shape = tool(name).inputShape;
      const rejected = z.object(shape).safeParse({ ...args, include: ["description"] });
      expect(rejected.success, `${name} include:["description"] should fail schema validation`).toBe(false);
      const accepted = z.object(shape).safeParse({ ...args, include: ["task"] });
      expect(accepted.success, `${name} include:["task"] should pass schema validation`).toBe(true);
    }
  });

  // ── task_start / task_pickup: receipt + slice unfold (rc-v1-C003) ───────
  //
  // receipt.ts's receiptForStart/projectPickup have their own dedicated unit
  // tests (tests/receipt.test.ts, including the pickup+start composition
  // test). These only prove the handler wiring: request-building is
  // untouched (already covered by the reclassify tests above), the default
  // response goes through the new projection, include:["task"] still
  // bypasses it, and the two verbs' include enums accept exactly their own
  // vocabulary at the zod schema level (mutation-resistant: re-widening or
  // narrowing either enum fails this test even if every handler-level test
  // stays green).

  // rc-v1-B001 fix round 1 (MEDIUM finding): this fixture has no
  // effectiveGates/previousStatus, so it only exercises the pre-B001
  // fallback wiring (deriveGateExpectations' static default-workflow.ts
  // table). See the sibling test right below for the current
  // (rc-v1-B001+) backend-authoritative wiring; naming mirrors
  // receipt.test.ts's "pre-B001 fallback (effectiveGates absent)" describe.
  it("task_start returns a receipt + slice by default, not the raw full task (pre-B001 fallback wiring: fixture has no effectiveGates/previousStatus)", async () => {
    fetchMock.mockResolvedValue(
      ok({
        kind: "work",
        task: {
          id: "t1",
          status: "in_progress",
          description: "SECRET DESCRIPTION",
          templateData: { taskType: "bugfix" },
          comments: [{ id: "c1", content: "SECRET COMMENT" }],
          workflowId: null,
        },
        expectedFinishState: "review",
        project: { id: "p1", slug: "proj" },
      }),
    );
    const result = await tool("task_start").handler({ taskId: TASK_ID } as never);
    expect(result).toEqual({
      ok: true,
      task: { id: "t1", status: "in_progress" },
      inferredTaskType: "bugfix",
      expectedFinishState: "review",
      gateExpectations: ["branchPresent", "prPresent"],
      gateExpectationsSource: "assumed-default-workflow",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("project");
    expect(serializeResult(result).length).toBeLessThanOrEqual(1200);
  });

  // rc-v1-B001 fix round 1 (MEDIUM finding): the test above only ever
  // exercised the pre-B001 fallback fixture; nothing at the handler level
  // (tool("task_start").handler(...) through the real tools.ts wiring, not
  // receipt.ts's unit tests directly) proved the CURRENT backend's
  // effectiveGates/previousStatus fields actually reach the caller through
  // this call path. A distinguishing gate list (["ciGreen"], different from
  // the default-workflow fallback's ["branchPresent", "prPresent"] for the
  // same open -> review edge) proves the backend value is consumed, not
  // re-derived client-side.
  it("task_start consumes the backend's effectiveGates/previousStatus (rc-v1-B001 wiring): transition + the backend's own gate list, no gateExpectationsSource, within budget", async () => {
    fetchMock.mockResolvedValue(
      ok({
        kind: "work",
        task: {
          id: "t1",
          status: "in_progress",
          templateData: { taskType: "bugfix" },
          workflowId: null,
        },
        expectedFinishState: "review",
        effectiveGates: { finish: ["ciGreen"] },
        previousStatus: "open",
      }),
    );
    const result = await tool("task_start").handler({ taskId: TASK_ID } as never);
    expect(result).toEqual({
      ok: true,
      task: { id: "t1", status: "in_progress" },
      transition: { from: "open", to: "in_progress" },
      inferredTaskType: "bugfix",
      expectedFinishState: "review",
      gateExpectations: ["ciGreen"],
    });
    expect(result).not.toHaveProperty("gateExpectationsSource");
    expect(serializeResult(result).length).toBeLessThanOrEqual(1200);
  });

  it("task_start include:[\"task\"] returns the full, pre-contract backend object", async () => {
    const backendBody = {
      kind: "work",
      task: { id: "t1", status: "in_progress", description: "d" },
      expectedFinishState: "review",
      project: { id: "p1", slug: "proj" },
    };
    fetchMock.mockResolvedValue(ok(backendBody));
    const result = await tool("task_start").handler({ taskId: TASK_ID, include: ["task"] } as never);
    expect(result).toEqual(backendBody);
  });

  it("task_start include:[\"description\"] adds back only description, not comments or the full object", async () => {
    fetchMock.mockResolvedValue(
      ok({
        kind: "work",
        task: { id: "t1", status: "in_progress", description: "the spec", comments: [{ id: "c1" }] },
        expectedFinishState: "review",
      }),
    );
    const result = await tool("task_start").handler({
      taskId: TASK_ID,
      include: ["description"],
    } as never) as Record<string, unknown>;
    expect(result.description).toBe("the spec");
    expect(result).not.toHaveProperty("comments");
    expect(result).not.toHaveProperty("project");
  });

  it("task_start include schema accepts description/instructions/comments/task and rejects the artifacts read-vocabulary value", () => {
    const shape = tool("task_start").inputShape;
    for (const value of ["description", "instructions", "comments", "task"]) {
      const accepted = z.object(shape).safeParse({ taskId: TASK_ID, include: [value] });
      expect(accepted.success, `task_start include:["${value}"] should pass schema validation`).toBe(true);
    }
    const rejected = z.object(shape).safeParse({ taskId: TASK_ID, include: ["artifacts"] });
    expect(rejected.success, 'task_start include:["artifacts"] should fail schema validation').toBe(false);
  });

  it("task_pickup returns the full spec without comments by default", async () => {
    fetchMock.mockResolvedValue(
      ok({
        kind: "work",
        task: { id: "t1", status: "open", description: "the spec", comments: [{ id: "c1", content: "note" }] },
      }),
    );
    const result = await tool("task_pickup").handler({} as never) as Record<string, unknown>;
    const task = result.task as Record<string, unknown>;
    expect(task.description).toBe("the spec");
    expect(task).not.toHaveProperty("comments");
  });

  it("task_pickup include:[\"comments\"] and include:[\"task\"] both restore the untouched raw response", async () => {
    const backendBody = {
      kind: "work",
      task: { id: "t1", status: "open", description: "the spec", comments: [{ id: "c1", content: "note" }] },
    };
    fetchMock.mockResolvedValue(ok(backendBody));
    const commentsResult = await tool("task_pickup").handler({ include: ["comments"] } as never);
    expect(commentsResult).toEqual(backendBody);

    fetchMock.mockResolvedValue(ok(backendBody));
    const taskResult = await tool("task_pickup").handler({ include: ["task"] } as never);
    expect(taskResult).toEqual(backendBody);
  });

  it("task_pickup passes idle/signal kinds through unchanged (no task.comments to strip)", async () => {
    fetchMock.mockResolvedValue(ok({ kind: "idle" }));
    expect(await tool("task_pickup").handler({} as never)).toEqual({ kind: "idle" });
  });

  it("task_pickup include schema accepts comments/task and rejects the description read-vocabulary value", () => {
    const shape = tool("task_pickup").inputShape;
    for (const value of ["comments", "task"]) {
      const accepted = z.object(shape).safeParse({ include: [value] });
      expect(accepted.success, `task_pickup include:["${value}"] should pass schema validation`).toBe(true);
    }
    const rejected = z.object(shape).safeParse({ include: ["description"] });
    expect(rejected.success, 'task_pickup include:["description"] should fail schema validation').toBe(false);
  });

  // This composition fixture is also pre-B001 (no effectiveGates/
  // previousStatus): its purpose is proving the pickup+start pairing covers
  // the listed fields, not exercising rc-v1-B001 wiring, which the two
  // dedicated task_start tests above already cover.
  it("task_pickup + task_start composition: calling only these two verbs covers description, acceptance criteria, status, expectedFinishState, and gates", async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        kind: "work",
        task: {
          id: "t1",
          status: "open",
          description: "Fix the bug in the parser",
          templateData: { taskType: "bugfix", acceptanceCriteria: "no longer throws on empty input" },
          comments: [{ id: "c1", content: "internal note" }],
        },
      }),
    );
    const pickupResult = (await tool("task_pickup").handler({} as never)) as { task: Record<string, unknown> };

    fetchMock.mockResolvedValueOnce(
      ok({
        kind: "work",
        task: { id: "t1", status: "in_progress", templateData: { taskType: "bugfix" }, workflowId: null },
        expectedFinishState: "review",
      }),
    );
    const startResult = (await tool("task_start").handler({ taskId: TASK_ID } as never)) as Record<string, unknown>;

    expect(pickupResult.task.description).toBe("Fix the bug in the parser");
    expect(
      (pickupResult.task.templateData as Record<string, unknown>).acceptanceCriteria,
    ).toBe("no longer throws on empty input");
    expect(pickupResult.task.status).toBe("open");
    expect(startResult.expectedFinishState).toBe("review");
    expect(startResult.gateExpectations).toEqual(["branchPresent", "prPresent"]);
  });

  // ── tasks_get: summary default + include (rc-v1-C006) ───────────────────

  // ── project_tasks: returns summary rows by default (task 3653962f) ────

  describe("project_tasks returns summary rows", () => {
    it("returns a summary row per task by default, not the full row, and never echoes description/templateData", async () => {
      fetchMock.mockResolvedValueOnce(
        ok({
          tasks: [
            {
              id: "t1",
              title: "Fix the bug",
              status: "in_progress",
              priority: "HIGH",
              labels: ["bug"],
              externalRef: "ext-1",
              createdAt: "2026-08-01T00:00:00.000Z",
              prUrl: "https://github.com/o/r/pull/9",
              claimedByUser: { id: "u1", name: "Lan" },
              blockedBy: [{ id: "b1", title: "Blocker", status: "done" }],
              description: "SECRET description",
              templateData: { taskType: "bugfix", notes: "SECRET template notes" },
            },
          ],
          nextCursor: null,
        }),
      );
      const result = await tool("project_tasks").handler({
        project: "00000000-0000-0000-0000-000000000001",
      } as never);
      expect(result).toEqual({
        tasks: [
          {
            id: "t1",
            title: "Fix the bug",
            status: "in_progress",
            priority: "HIGH",
            labels: ["bug"],
            externalRef: "ext-1",
            createdAt: "2026-08-01T00:00:00.000Z",
            claims: { work: "Lan" },
            blockedBy: [{ id: "b1", title: "Blocker", status: "done" }],
            prUrl: "https://github.com/o/r/pull/9",
          },
        ],
        nextCursor: null,
      });
      expect(JSON.stringify(result)).not.toContain("SECRET");
    });

    it.each(["description", "templateData"] as const)(
      'include:["%s"] adds back only that field, per row',
      async (field) => {
        fetchMock.mockResolvedValueOnce(
          ok({
            tasks: [
              {
                id: "t1",
                title: "Fix the bug",
                description: "the spec",
                templateData: { taskType: "feature" },
              },
            ],
            nextCursor: null,
          }),
        );
        const result = (await tool("project_tasks").handler({
          project: "00000000-0000-0000-0000-000000000001",
          include: [field],
        } as never)) as { tasks: Record<string, unknown>[] };
        expect(result.tasks[0]?.[field]).toBeDefined();
        for (const other of ["description", "templateData"] as const) {
          if (other !== field) expect(result.tasks[0]).not.toHaveProperty(other);
        }
      },
    );

    it('include:["task"] returns the full, pre-contract { tasks, nextCursor } object unchanged', async () => {
      const backendBody = {
        tasks: [{ id: "t1", title: "Fix the bug", status: "open", description: "d" }],
        nextCursor: "cursor-1",
      };
      fetchMock.mockResolvedValueOnce(ok(backendBody));
      const result = await tool("project_tasks").handler({
        project: "00000000-0000-0000-0000-000000000001",
        include: ["task"],
      } as never);
      expect(result).toEqual(backendBody);
    });

    it("include schema accepts description/templateData/task and rejects an unknown value with a schema validation error", () => {
      const shape = tool("project_tasks").inputShape;
      for (const value of ["description", "templateData", "task"]) {
        const accepted = z.object(shape).safeParse({
          project: "00000000-0000-0000-0000-000000000001",
          include: [value],
        });
        expect(accepted.success, `project_tasks include:["${value}"] should pass schema validation`).toBe(true);
      }
      const rejected = z.object(shape).safeParse({
        project: "00000000-0000-0000-0000-000000000001",
        include: ["comments"],
      });
      expect(
        rejected.success,
        'project_tasks include:["comments"] should fail schema validation (not part of project_tasks\'s vocabulary)',
      ).toBe(false);
    });

    it("nextCursor is preserved unchanged through the default projection", async () => {
      fetchMock.mockResolvedValueOnce(
        ok({ tasks: [{ id: "t1", title: "A" }], nextCursor: "some-task-id" }),
      );
      const result = (await tool("project_tasks").handler({
        project: "00000000-0000-0000-0000-000000000001",
      } as never)) as { nextCursor: string | null };
      expect(result.nextCursor).toBe("some-task-id");
    });

    it("SIZE BOUND: a 40-row page with 3kB descriptions/templateData per row stays under 20kB serialized by default", async () => {
      const tasks = Array.from({ length: 40 }, (_, i) => ({
        id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
        title: `Task number ${i}`,
        status: "open",
        priority: "MEDIUM",
        labels: ["mcp", "dx"],
        externalRef: `ext-${i}`,
        createdAt: "2026-08-01T00:00:00.000Z",
        description: "d".repeat(3000),
        templateData: { taskType: "feature", notes: "n".repeat(2000) },
      }));
      fetchMock.mockResolvedValueOnce(ok({ tasks, nextCursor: null }));
      const result = await tool("project_tasks").handler({
        project: "00000000-0000-0000-0000-000000000001",
      } as never);
      expect(serializeResult(result).length).toBeLessThan(20_000);
    });
  });

  describe("tasks_get", () => {
    const GET_TASK_ID = "33333333-3333-3333-3333-333333333333";

    it("returns a summary projection by default, not the full task, and never echoes description/comments/artifacts", async () => {
      fetchMock.mockResolvedValue(
        ok({
          task: {
            id: "t1",
            title: "Fix the bug",
            status: "in_progress",
            priority: "HIGH",
            labels: ["bug"],
            prUrl: "https://github.com/o/r/pull/9",
            claimedByUser: { id: "u1", name: "Lan" },
            blockedBy: [{ id: "b1", title: "Blocker", status: "done" }],
            description: "SECRET description",
            comments: [{ id: "c1", content: "SECRET comment" }],
            artifacts: [{ id: "a1", name: "SECRET artifact" }],
          },
        }),
      );
      const result = await tool("tasks_get").handler({ taskId: GET_TASK_ID } as never);
      expect(result).toEqual({
        task: {
          id: "t1",
          title: "Fix the bug",
          status: "in_progress",
          priority: "HIGH",
          labels: ["bug"],
          claims: { work: "Lan" },
          blockedBy: [{ id: "b1", title: "Blocker", status: "done" }],
          prUrl: "https://github.com/o/r/pull/9",
        },
      });
      expect(JSON.stringify(result)).not.toContain("SECRET");
    });

    it.each(["description", "comments", "artifacts"] as const)(
      'include:["%s"] adds back only that field',
      async (field) => {
        fetchMock.mockResolvedValue(
          ok({
            task: {
              id: "t1",
              title: "Fix the bug",
              description: "the spec",
              comments: [{ id: "c1" }],
              artifacts: [{ id: "a1" }],
            },
          }),
        );
        const result = (await tool("tasks_get").handler({
          taskId: GET_TASK_ID,
          include: [field],
        } as never)) as { task: Record<string, unknown> };
        expect(result.task[field]).toBeDefined();
        for (const other of ["description", "comments", "artifacts"] as const) {
          if (other !== field) expect(result.task).not.toHaveProperty(other);
        }
      },
    );

    it('include:["task"] returns the full, pre-contract { task } object unchanged', async () => {
      const backendBody = {
        task: { id: "t1", title: "Fix the bug", status: "open", description: "d" },
      };
      fetchMock.mockResolvedValue(ok(backendBody));
      const result = await tool("tasks_get").handler({
        taskId: GET_TASK_ID,
        include: ["task"],
      } as never);
      expect(result).toEqual(backendBody);
    });

    it("include schema accepts description/comments/artifacts/task and rejects the write-verb-only 'instructions' value (not part of tasks_get's vocabulary)", () => {
      const shape = tool("tasks_get").inputShape;
      for (const value of ["description", "comments", "artifacts", "task"]) {
        const accepted = z.object(shape).safeParse({ taskId: GET_TASK_ID, include: [value] });
        expect(accepted.success, `tasks_get include:["${value}"] should pass schema validation`).toBe(true);
      }
      const rejected = z.object(shape).safeParse({ taskId: GET_TASK_ID, include: ["instructions"] });
      expect(rejected.success, 'tasks_get include:["instructions"] should fail schema validation').toBe(false);
    });

    it("SUMMARY BUDGET: a realistic happy-path summary stays well within a small ceiling (measured, not aspirational)", async () => {
      fetchMock.mockResolvedValue(
        ok({
          task: {
            id: "t1",
            title: "Fix the login redirect loop",
            status: "in_progress",
            priority: "HIGH",
            labels: ["bug", "auth"],
            prUrl: "https://github.com/o/r/pull/42",
            claimedByUser: { id: "u1", name: "Lan" },
            blockedBy: [{ id: "b1", title: "Add auth middleware", status: "done" }],
          },
        }),
      );
      const result = await tool("tasks_get").handler({ taskId: GET_TASK_ID } as never);
      expect(serializeResult(result).length).toBeLessThanOrEqual(600);
    });
  });

  // ── project_tasks: unknown project slug (rc-v1-C006) ─────────────────────

  // rc-v1-C007: projects_list is legacy-gated now (pruned from the default
  // registration); project_tasks stays default-registered, so allowedNext
  // no longer names projects_list unconditionally (see errors.ts's
  // unknownProjectSlugError). The recipe still mentions it as the
  // AGENT_TASKS_MCP_LEGACY=1 option.
  it("project_tasks maps an unresolvable project slug to the unknown_project_slug teaching error, mentioning projects_list only as the legacy-flag option", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "not_found", message: "Resource not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    let captured = "";
    try {
      await tool("project_tasks").handler({ project: "ghost-project" } as never);
      throw new Error("expected a throw");
    } catch (e) {
      captured = e instanceof Error ? e.message : String(e);
    }
    const parsed = JSON.parse(captured);
    expect(parsed.error.code).toBe("unknown_project_slug");
    expect(parsed.error.recipe).toContain("projects_list");
    expect(parsed.error.recipe).toContain("AGENT_TASKS_MCP_LEGACY=1");
    expect(parsed.error.allowedNext).toEqual(["project_tasks"]);
  });

  // ── task_create: project/projectId/projectSlug addressing (rc-v1-C006,
  // widened to a unified `project` field) ──────────────────────────────────

  describe("task_create project addressing", () => {
    it("passing both projectId and projectSlug is a project_addressing_conflict teaching error, no network call made", async () => {
      let captured = "";
      try {
        await tool("task_create").handler({
          projectId: "22222222-2222-2222-2222-222222222222",
          projectSlug: "agent-tasks",
          title: "t",
        } as never);
        throw new Error("expected a throw");
      } catch (e) {
        captured = e instanceof Error ? e.message : String(e);
      }
      const parsed = JSON.parse(captured);
      expect(parsed).toEqual({
        ok: false,
        error: {
          code: "project_addressing_conflict",
          message: "projectId and projectSlug were both provided; pass exactly one",
          recipe: "resubmit task_create with only one of projectId or projectSlug",
          allowedNext: ["task_create"],
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("passing none of project, projectId, or projectSlug is a project_addressing_conflict teaching error mentioning projects_list only as the legacy-flag option, no network call made", async () => {
      let captured = "";
      try {
        await tool("task_create").handler({ title: "t" } as never);
        throw new Error("expected a throw");
      } catch (e) {
        captured = e instanceof Error ? e.message : String(e);
      }
      const parsed = JSON.parse(captured);
      expect(parsed).toEqual({
        ok: false,
        error: {
          code: "project_addressing_conflict",
          message: "none of project, projectId, or projectSlug was provided; pass exactly one",
          recipe:
            "ask the operator for this project's slug or id (or, with AGENT_TASKS_MCP_LEGACY=1 set, call projects_list), then resubmit task_create with project, projectId, or projectSlug set",
          allowedNext: ["task_create"],
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("passing project and projectId is a project_addressing_conflict teaching error naming both fields, no network call made", async () => {
      let captured = "";
      try {
        await tool("task_create").handler({
          project: "agent-tasks",
          projectId: "22222222-2222-2222-2222-222222222222",
          title: "t",
        } as never);
        throw new Error("expected a throw");
      } catch (e) {
        captured = e instanceof Error ? e.message : String(e);
      }
      const parsed = JSON.parse(captured);
      expect(parsed).toEqual({
        ok: false,
        error: {
          code: "project_addressing_conflict",
          message: "project and projectId were both provided; pass exactly one",
          recipe: "resubmit task_create with only one of project or projectId",
          allowedNext: ["task_create"],
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("passing project and projectSlug is a project_addressing_conflict teaching error naming both fields, no network call made", async () => {
      let captured = "";
      try {
        await tool("task_create").handler({
          project: "agent-tasks",
          projectSlug: "other-project",
          title: "t",
        } as never);
        throw new Error("expected a throw");
      } catch (e) {
        captured = e instanceof Error ? e.message : String(e);
      }
      const parsed = JSON.parse(captured);
      expect(parsed).toEqual({
        ok: false,
        error: {
          code: "project_addressing_conflict",
          message: "project and projectSlug were both provided; pass exactly one",
          recipe: "resubmit task_create with only one of project or projectSlug",
          allowedNext: ["task_create"],
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("a UUID passed as project skips slug resolution and creates the task directly", async () => {
      fetchMock.mockResolvedValueOnce(
        ok({ task: { id: "t1", status: "open" }, confidence: { score: 90, threshold: 60, enforcementMode: "BLOCK" } }),
      );
      const result = await tool("task_create").handler({
        project: "00000000-0000-0000-0000-000000000001",
        title: "New task",
      } as never);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        "https://example.test/api/projects/00000000-0000-0000-0000-000000000001/tasks",
      );
      expect(JSON.parse(init.body)).toEqual({ title: "New task" });
      expect(result).toEqual({
        ok: true,
        task: { id: "t1", status: "open" },
        confidence: 90,
        next: ["task_start to begin work on this task"],
      });
    });

    it("a slug passed as project resolves to the project id and creates the task there, returning the usual receipt", async () => {
      fetchMock
        .mockResolvedValueOnce(ok({ project: { id: "p1" } }))
        .mockResolvedValueOnce(
          ok({ task: { id: "t1", status: "open" }, confidence: { score: 90, threshold: 60, enforcementMode: "BLOCK" } }),
        );
      const result = await tool("task_create").handler({ project: "agent-tasks", title: "New task" } as never);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://example.test/api/projects/by-slug/agent-tasks",
      );
      const [url, init] = fetchMock.mock.calls[1];
      expect(url).toBe("https://example.test/api/projects/p1/tasks");
      expect(JSON.parse(init.body)).toEqual({ title: "New task" });
      expect(result).toEqual({
        ok: true,
        task: { id: "t1", status: "open" },
        confidence: 90,
        next: ["task_start to begin work on this task"],
      });
    });

    it("an unresolvable project slug maps to the unknown_project_slug teaching error, mentioning projects_list only as the legacy-flag option, and never reaches the create endpoint", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: "not_found", message: "Resource not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      );
      let captured = "";
      try {
        await tool("task_create").handler({ project: "ghost-project", title: "t" } as never);
        throw new Error("expected a throw");
      } catch (e) {
        captured = e instanceof Error ? e.message : String(e);
      }
      const parsed = JSON.parse(captured);
      expect(parsed.error.code).toBe("unknown_project_slug");
      expect(parsed.error.message).toContain("ghost-project");
      expect(parsed.error.recipe).toContain("projects_list");
      expect(parsed.error.recipe).toContain("AGENT_TASKS_MCP_LEGACY=1");
      expect(parsed.error.allowedNext).toEqual(["task_create"]);
      expect(fetchMock).toHaveBeenCalledTimes(1); // only the failed by-slug lookup
    });

    it("an unresolvable projectSlug maps to the unknown_project_slug teaching error, mentioning projects_list only as the legacy-flag option, and never reaches the create endpoint", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: "not_found", message: "Resource not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      );
      let captured = "";
      try {
        await tool("task_create").handler({ projectSlug: "ghost-project", title: "t" } as never);
        throw new Error("expected a throw");
      } catch (e) {
        captured = e instanceof Error ? e.message : String(e);
      }
      const parsed = JSON.parse(captured);
      expect(parsed.error.code).toBe("unknown_project_slug");
      expect(parsed.error.message).toContain("ghost-project");
      expect(parsed.error.recipe).toContain("projects_list");
      expect(parsed.error.recipe).toContain("AGENT_TASKS_MCP_LEGACY=1");
      expect(parsed.error.allowedNext).toEqual(["task_create"]);
      expect(fetchMock).toHaveBeenCalledTimes(1); // only the failed by-slug lookup
    });

    it("a resolvable projectSlug resolves to the project id and creates the task there, returning the usual receipt", async () => {
      fetchMock
        .mockResolvedValueOnce(ok({ project: { id: "p1" } }))
        .mockResolvedValueOnce(
          ok({ task: { id: "t1", status: "open" }, confidence: { score: 90, threshold: 60, enforcementMode: "BLOCK" } }),
        );
      const result = await tool("task_create").handler({ projectSlug: "agent-tasks", title: "New task" } as never);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://example.test/api/projects/by-slug/agent-tasks",
      );
      const [url, init] = fetchMock.mock.calls[1];
      expect(url).toBe("https://example.test/api/projects/p1/tasks");
      expect(JSON.parse(init.body)).toEqual({ title: "New task" });
      expect(result).toEqual({
        ok: true,
        task: { id: "t1", status: "open" },
        confidence: 90,
        next: ["task_start to begin work on this task"],
      });
    });

    // ── cache-served id, downstream 403, retry's own fresh lookup 404s
    // (rc-v1-C006 round-2 review): pins that this end-to-end path surfaces
    // the unknown_project_slug TEACHING ERROR, not a raw, unparsed
    // ProjectSlugNotFoundError message. Uses a single shared client (unlike
    // most tests in this describe block, which call the `tool()` helper
    // and get a fresh client with an empty slug cache each time) so the
    // second task_create call can actually reuse a cache-served id.
    it("cache-served projectSlug, downstream 403, the retry's own fresh by-slug lookup 404s: surfaces unknown_project_slug, not a raw error leak", async () => {
      const client = new AgentTasksClient(config);
      const create = buildTools(client).find((t) => t.name === "task_create");
      if (!create) throw new Error("task_create not registered");

      fetchMock
        .mockResolvedValueOnce(ok({ project: { id: "p-old" } })) // warm the cache
        .mockResolvedValueOnce(ok({ task: { id: "t-old", status: "open" } }));
      await create.handler({ projectSlug: "agent-tasks", title: "warm the cache" } as never);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      fetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "forbidden", message: "Access denied to this project" }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "not_found", message: "Resource not found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
        );

      let captured = "";
      try {
        await create.handler({ projectSlug: "agent-tasks", title: "New task" } as never);
        throw new Error("expected a throw");
      } catch (e) {
        captured = e instanceof Error ? e.message : String(e);
      }
      // Not a raw, unparsed error (e.g. `no project found for slug "..."`
      // with no JSON structure) -- must parse as the teaching-error shape.
      const parsed = JSON.parse(captured);
      expect(parsed.error.code).toBe("unknown_project_slug");
      expect(parsed.error.message).toContain("agent-tasks");
      expect(parsed.error.recipe).toContain("projects_list");
      expect(parsed.error.recipe).toContain("AGENT_TASKS_MCP_LEGACY=1");
      expect(parsed.error.allowedNext).toEqual(["task_create"]);
    });

    // ── R1 review, F1: the declared zod shape for `project` stays a
    // permissive slug-or-UUID string, not narrowed to z.string().uuid() --
    // narrowing it would silently break every slug caller through the real
    // MCP SDK (McpServer.registerTool parses inputShape before the handler
    // ever runs; the handler tests above call `tool().handler()` directly
    // and never exercise that parse step). Exercised via parseArgs (the
    // real schema), so a future accidental narrowing is caught here even
    // if every handler-level test above stays green.
    it("task_create's declared schema accepts a slug value for project (not narrowed to UUID-only)", () => {
      const parsed = parseArgs("task_create", { project: "some-slug", title: "t" });
      expect(parsed.project).toBe("some-slug");
    });

    it("task_create's declared schema accepts a UUID value for project", () => {
      const parsed = parseArgs("task_create", {
        project: "00000000-0000-0000-0000-000000000001",
        title: "t",
      });
      expect(parsed.project).toBe("00000000-0000-0000-0000-000000000001");
    });

    // ── R1 review, F3: `project`'s input hygiene now matches sibling
    // projectSlug (.trim().min(1).max(255)) instead of the bare
    // z.string().min(1) it shipped with -- a whitespace-padded slug now
    // trims and resolves instead of 404ing on the untrimmed value.
    it("task_create trims a whitespace-padded project slug before resolving", async () => {
      fetchMock
        .mockResolvedValueOnce(ok({ project: { id: "p1" } }))
        .mockResolvedValueOnce(
          ok({ task: { id: "t1", status: "open" }, confidence: { score: 90, threshold: 60, enforcementMode: "BLOCK" } }),
        );
      const parsed = parseArgs("task_create", { project: "agent-tasks ", title: "New task" });
      expect(parsed.project).toBe("agent-tasks");
      await tool("task_create").handler(parsed);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://example.test/api/projects/by-slug/agent-tasks",
      );
    });
  });

  // ── signals_poll: default limit, truncated + cursor, no silent loss
  // (rc-v1-C006) ────────────────────────────────────────────────────────

  describe("signals_poll", () => {
    function sig(id: string) {
      return { id, type: "review_needed" };
    }

    it("returns everything untouched when the backlog is under the default limit", async () => {
      fetchMock.mockResolvedValue(ok({ signals: [sig("s1"), sig("s2")] }));
      const result = await tool("signals_poll").handler({} as never);
      expect(result).toEqual({ signals: [sig("s1"), sig("s2")] });
      // mcp-server always asks the backend for its own max, regardless of
      // the caller's own (unset, default) limit.
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe("https://example.test/api/agent/signals?limit=200");
    });

    it("caps to the default limit and sets truncated:true + a cursor when the backend backlog is larger", async () => {
      const all = Array.from({ length: 15 }, (_, i) => sig(`s${i}`));
      fetchMock.mockResolvedValue(ok({ signals: all }));
      const result = (await tool("signals_poll").handler({} as never)) as {
        signals: unknown[];
        truncated?: boolean;
        cursor?: string;
      };
      expect(result.signals.length).toBe(10);
      expect(result.truncated).toBe(true);
      expect(result.cursor).toBe("s9");
    });

    it("NO SIGNAL IS LOST: a follow-up call with the returned cursor yields exactly the remainder", async () => {
      const all = Array.from({ length: 15 }, (_, i) => sig(`s${i}`));
      fetchMock.mockResolvedValue(ok({ signals: all }));
      const first = (await tool("signals_poll").handler({} as never)) as {
        signals: { id: string }[];
        truncated?: boolean;
        cursor?: string;
      };
      expect(first.truncated).toBe(true);

      fetchMock.mockResolvedValue(ok({ signals: all }));
      const second = (await tool("signals_poll").handler({ cursor: first.cursor } as never)) as {
        signals: { id: string }[];
        truncated?: boolean;
      };
      expect(second.truncated).toBeUndefined();

      const combined = [...first.signals, ...second.signals].map((s) => s.id);
      expect(combined).toEqual(all.map((s) => s.id));
    });

    it("respects an explicit smaller limit", async () => {
      fetchMock.mockResolvedValue(ok({ signals: [sig("s1"), sig("s2"), sig("s3")] }));
      const result = (await tool("signals_poll").handler({ limit: 1 } as never)) as {
        signals: unknown[];
        truncated?: boolean;
      };
      expect(result.signals).toEqual([sig("s1")]);
      expect(result.truncated).toBe(true);
    });

    it("zod schema rejects a limit over the max and accepts one at the max", () => {
      expect(() => parseArgs("signals_poll", { limit: 101 })).toThrow();
      expect(() => parseArgs("signals_poll", { limit: 100 })).not.toThrow();
    });

    // ── atBackendFetchCeiling end-to-end (rc-v1-C006 round-2 review, HIGH) ──
    //
    // Simulates a true backend backlog (260 signals) larger than the
    // backend's own hard fetch max (200, SIGNALS_BACKEND_FETCH_LIMIT): the
    // mock backend, like the real one, hands back only its first 200
    // regardless of how many are truly pending. Pages through with the
    // default limit to the FINAL local page and checks both fields the
    // review asked to be quoted: what truncated says there (absent, since
    // local pagination over the 200-entry fetch is genuinely exhausted) and
    // that atBackendFetchCeiling:true still appears (since the fetch itself
    // may have clipped a larger true backlog -- ack and poll again, do not
    // assume drained).
    it("260-signal true backlog (backend clips to 200): the final local page carries atBackendFetchCeiling:true even though truncated is absent", async () => {
      const backendBacklog = Array.from({ length: 260 }, (_, i) => sig(`s${i}`));
      const backendServed = backendBacklog.slice(0, SIGNALS_BACKEND_FETCH_LIMIT); // backend's own hard max
      // A fresh Response per call, not a single shared/reused instance: each
      // call reads its own Response body, and a Response's body stream can
      // only be read once (this test polls the same mocked endpoint many
      // times in a loop below, unlike most single-call tests in this file).
      fetchMock.mockImplementation(async () => ok({ signals: backendServed }));

      let cursor: string | undefined;
      let last: { signals: unknown[]; truncated?: boolean; cursor?: string; atBackendFetchCeiling?: boolean } | undefined;
      const pageCount = Math.ceil(SIGNALS_BACKEND_FETCH_LIMIT / SIGNALS_DEFAULT_LIMIT);
      for (let i = 0; i < pageCount; i++) {
        last = (await tool("signals_poll").handler({ cursor } as never)) as typeof last;
        cursor = last?.cursor;
      }
      expect(last?.signals.length).toBe(SIGNALS_DEFAULT_LIMIT);
      expect(last?.truncated).toBeUndefined();
      expect(last?.atBackendFetchCeiling).toBe(true);
    });
  });
});
