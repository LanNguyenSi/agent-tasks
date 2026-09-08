import { createHash } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
vi.mock("../../src/services/github-delegation.js", () => ({ findDelegationUser: vi.fn() }));
vi.mock("../../src/services/team-access.js", () => ({ requireProjectWrite: vi.fn(), hasProjectRole: vi.fn() }));
import { findDelegationUser } from "../../src/services/github-delegation.js";
import { canonicalGroundingJson, projectGroundingContext, resolveGroundingTarget, fetchGroundingHead } from "../../src/services/grounding-context.js";
import { defaultWorkflowDefinition } from "../../src/services/default-workflow.js";
import { actor, ids, taskFixture, bindingFixture, workflowDb, headSha } from "../helpers/grounding-fixtures.js";

const authority = { canWrite: vi.fn(async () => true), hasRole: vi.fn(async () => true) };
const target = { workflowId: null, from: "in_progress", to: "review", action: "finish" };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); authority.canWrite.mockResolvedValue(true); authority.hasRole.mockResolvedValue(true); });

describe("task-context/v1 bytes", () => {
  it("pins sorted keys, number encoding, scalar Unicode, array order and no normalization", () => {
    const bytes = canonicalGroundingJson({ z: "café😀\r\n", a: [null, true, 1e-7, -0, { z: "é", a: "e\u0301" }] });
    expect(bytes).toBe('{"a":[null,true,1e-7,0,{"a":"é","z":"é"}],"z":"café😀\\r\\n"}');
    expect(Buffer.from(bytes).toString("hex")).toBe("7b2261223a5b6e756c6c2c747275652c31652d372c302c7b2261223a2265cc81222c227a223a22c3a9227d5d2c227a223a22636166c3a9f09f98805c725c6e227d");
    expect(() => canonicalGroundingJson("\ud800")).toThrow("grounding_verification_unavailable");
    expect(() => canonicalGroundingJson({ x: undefined })).toThrow();
  });
  it("pins the full projection's exact UTF-8 bytes independently", async () => {
    const task = taskFixture();
    const context = await projectGroundingContext(task, bindingFixture(), target, { z: "line\r\n", a: [2, 1] }, actor, async () => headSha);
    const expected = '{"audience":"consumer.test","claims":{"reviewAgentId":null,"reviewUserId":null,"workAgentId":"00000000-0000-4000-8000-000000000004","workUserId":null},"deliverable":{"branchName":"task/branch","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","prNumber":42,"prUrl":"https://github.com/acme/repo/pull/42","repo":"acme/repo"},"description":"Line one\\r\\nLine two","policy":{"id":"debug-evidence-assessment/v1","revision":"1","sha256":"50c68e4070b5c36c2bd166f61f83377df717253f30933fe05825386d605325a4"},"project":{"githubRepo":"acme/repo","governanceMode":"AWAITS_CONFIRMATION","taskTemplate":null,"teamId":"00000000-0000-4000-8000-000000000003"},"projectId":"00000000-0000-4000-8000-000000000002","protection":{"protected":true,"subjectMode":"CODE_HEAD"},"target":{"action":"finish","from":"in_progress","to":"review","workflowId":null},"taskId":"00000000-0000-4000-8000-000000000001","templateData":{"a":null,"z":"é"},"title":"Exact café 😀","version":"task-context/v1","workflow":{"definition":{"a":[2,1],"z":"line\\r\\n"},"id":null}}';
    expect(context.bytes.equals(Buffer.from(expected, "utf8"))).toBe(true);
    expect(context.digest).toBe(createHash("sha256").update(expected).digest("hex"));
  });
  it("metadata and display timestamps cannot enroll, remove protection or alter the digest", async () => {
    const task = taskFixture();
    const before = await projectGroundingContext(task, bindingFixture(), target, {}, actor, async () => headSha);
    task.metadata = { debugFlavor: false, pass: true, receipt: "forged", sessionId: "fake" };
    task.updatedAt = new Date();
    expect((await projectGroundingContext(task, bindingFixture(), target, {}, actor, async () => headSha)).bytes).toEqual(before.bytes);
    await expect(projectGroundingContext(task, { ...bindingFixture(), protected: false }, target, {}, actor, async () => headSha)).rejects.toThrow("grounding_verification_unavailable");
  });
  it("TASK_SPEC is an explicit protected mode and never asserts a code snapshot", async () => {
    const head = vi.fn();
    const context = await projectGroundingContext(taskFixture(), { ...bindingFixture(), subjectMode: "TASK_SPEC" }, target, {}, actor, head);
    expect(JSON.parse(context.bytes.toString()).deliverable.headSha).toBeNull();
    expect(head).not.toHaveBeenCalled();
  });
  it.each(["prUrl", "prNumber", "projectId"] as const)("rejects missing or mismatched registered %s", async field => {
    const task = taskFixture();
    if (field === "prNumber") task.prNumber = null;
    else task[field] = "foreign";
    await expect(projectGroundingContext(task, bindingFixture(), target, {}, actor, async () => headSha)).rejects.toThrow();
  });
});

describe("authorized existing workflow intent", () => {
  it("resolves built-in and real project-default workflow identity", async () => {
    expect((await resolveGroundingTarget(workflowDb(), taskFixture(), actor, "finish", authority)).target).toEqual(target);
    const workflowId = "00000000-0000-4000-8000-000000000006";
    expect((await resolveGroundingTarget(workflowDb(defaultWorkflowDefinition(), workflowId), taskFixture(), actor, "finish", authority)).target.workflowId).toBe(workflowId);
  });
  it("rejects missing claims, scope, project write and concrete workflow roles", async () => {
    await expect(resolveGroundingTarget(workflowDb(), taskFixture(), { ...actor, scopes: [] }, "finish", authority)).rejects.toMatchObject({ code: "forbidden" });
    await expect(resolveGroundingTarget(workflowDb(), { ...taskFixture(), claimedByAgentId: null }, actor, "finish", authority)).rejects.toMatchObject({ code: "forbidden" });
    authority.canWrite.mockResolvedValue(false);
    await expect(resolveGroundingTarget(workflowDb(), taskFixture(), actor, "finish", authority)).rejects.toMatchObject({ code: "forbidden" });
    authority.canWrite.mockResolvedValue(true); authority.hasRole.mockResolvedValue(false);
    const def = defaultWorkflowDefinition(); def.transitions.find(t => t.from === "in_progress" && t.to === "review")!.requiredRole = "REVIEWER";
    await expect(resolveGroundingTarget(workflowDb(def), taskFixture(), actor, "finish", authority)).rejects.toMatchObject({ code: "forbidden" });
  });
  it("rejects absent, duplicate and divergent edges instead of inventing a finish target", async () => {
    const def = defaultWorkflowDefinition(); def.transitions = def.transitions.filter(t => t.from !== "in_progress" || t.to !== "review");
    await expect(resolveGroundingTarget(workflowDb(def), taskFixture(), actor, "finish", authority)).rejects.toMatchObject({ code: "bad_state" });
    const duplicate = defaultWorkflowDefinition(); duplicate.transitions.push({ from: "in_progress", to: "review" });
    await expect(resolveGroundingTarget(workflowDb(duplicate), taskFixture(), actor, "finish", authority)).rejects.toMatchObject({ code: "bad_state" });
  });
  it("enforces review lock conflicts and distinct-reviewer rules, supports explicit approve and merge", async () => {
    const task = taskFixture(); task.status = "review";
    expect((await resolveGroundingTarget(workflowDb(), task, actor, "approve", authority)).target).toEqual({ ...target, from: "review", to: "done", action: "approve" });
    task.reviewClaimedByAgentId = ids.user;
    await expect(resolveGroundingTarget(workflowDb(), task, actor, "approve", authority)).rejects.toMatchObject({ code: "forbidden" });
    task.reviewClaimedByAgentId = actor.tokenId; task.project.requireDistinctReviewer = true;
    await expect(resolveGroundingTarget(workflowDb(), task, actor, "approve", authority)).rejects.toMatchObject({ code: "forbidden" });
    task.claimedByAgentId = ids.user;
    expect((await resolveGroundingTarget(workflowDb(), task, actor, "merge", authority)).target.action).toBe("merge");
  });
});

describe("fresh authorized GitHub head", () => {
  const input = { actor, teamId: ids.team, repo: "acme/repo", prNumber: 42 };
  const body = { number: 42, html_url: "https://github.com/acme/repo/pull/42", base: { repo: { full_name: "acme/repo" } }, head: { sha: headSha } };
  it("uses delegated read consent, fixed API URL, no cache, no redirects and a deadline each time", async () => {
    vi.mocked(findDelegationUser).mockResolvedValue({ userId: ids.user, login: "test", githubAccessToken: "test-only" });
    const fetcher = vi.fn(async () => Response.json(body)); vi.stubGlobal("fetch", fetcher);
    await expect(fetchGroundingHead(input)).resolves.toBe(headSha); await fetchGroundingHead(input);
    expect(findDelegationUser).toHaveBeenCalledWith(ids.team, "allowAgentPrCreate", { preferUserId: ids.user });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledWith("https://api.github.com/repos/acme/repo/pulls/42", expect.objectContaining({ cache: "no-store", redirect: "error", signal: expect.any(AbortSignal) }));
  });
  it("aborts a stalled authorized response at the configured deadline", async () => {
    vi.mocked(findDelegationUser).mockResolvedValue({ userId: ids.user, login: "test", githubAccessToken: "test-only" });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => new Response(new ReadableStream({
      start(controller) { init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true }); },
    }))));
    await expect(fetchGroundingHead(input)).rejects.toThrow("grounding_verification_unavailable");
  }, 8000);
  it.each([null, "error", "oversize", "number", "repo", "url", "sha"])("fails closed on %s", async kind => {
    vi.mocked(findDelegationUser).mockResolvedValue(kind === null ? null : { userId: ids.user, login: "test", githubAccessToken: "test-only" });
    const bad = structuredClone(body);
    if (kind === "number") bad.number = 43;
    if (kind === "repo") bad.base.repo.full_name = "evil/repo";
    if (kind === "url") bad.html_url = "https://evil.test";
    if (kind === "sha") bad.head.sha = "arbitrary";
    const fetcher = vi.fn(async () => kind === "error" ? new Response("", { status: 403 }) : kind === "oversize" ? new Response(" ".repeat(262145)) : Response.json(bad));
    vi.stubGlobal("fetch", fetcher);
    await expect(fetchGroundingHead(input)).rejects.toThrow("grounding_verification_unavailable");
    if (kind === null) expect(fetcher).not.toHaveBeenCalled();
  });
});
