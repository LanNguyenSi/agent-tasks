import { afterEach, it, expect, vi } from "vitest";
import { githubGroundingMergeProvider as provider } from "../../src/services/grounding-merge-provider.js";
const input = { repo: "acme/repo", prNumber: 42, headSha: "a".repeat(40), method: "squash" as const };
const proof = () => ({ number: 42, html_url: "https://github.com/acme/repo/pull/42", base: { repo: { full_name: "acme/repo" } }, head: { sha: input.headSha }, merged: true, state: "closed", merge_commit_sha: "b".repeat(40) });
afterEach(() => { vi.unstubAllGlobals(); });
it("pins PUT expected source sha and uses a separately validated GET merge commit", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ merged: true, sha: "b".repeat(40) })).mockResolvedValueOnce(Response.json(proof()));
  vi.stubGlobal("fetch", fetcher);
  await provider.merge(input, "secret-test-only");
  expect(fetcher.mock.calls[0][0]).toBe("https://api.github.com/repos/acme/repo/pulls/42/merge");
  const options = fetcher.mock.calls[0][1];
  expect(JSON.parse(options.body)).toEqual({ sha: input.headSha, merge_method: "squash" });
  expect(options).toMatchObject({ method: "PUT", redirect: "error", cache: "no-store" }); expect(options.signal).toBeInstanceOf(AbortSignal);
  expect(await provider.read(input, "secret-test-only")).toEqual({ repo: input.repo, prNumber: 42, headSha: input.headSha, merged: true, mergeCommitSha: "b".repeat(40) });
});
it.each(["number", "repo", "url", "state", "commit"])("rejects inconsistent provider %s identity", async field => {
  const body = proof();
  if (field === "number") body.number = 43;
  if (field === "repo") body.base.repo.full_name = "wrong/repo";
  if (field === "url") body.html_url = "https://evil.test/acme/repo/pull/42";
  if (field === "state") body.state = "open";
  if (field === "commit") body.merge_commit_sha = "invalid";
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
  await expect(provider.read(input, "token")).rejects.toBeInstanceOf(Error);
});
it("rejects oversized streamed bodies and unsafe paths before network", async () => {
  const cancelled = vi.fn();
  const fetcher = vi.fn(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(262145)); }, cancel: cancelled })));
  vi.stubGlobal("fetch", fetcher);
  await expect(provider.read(input, "token")).rejects.toBeInstanceOf(Error); expect(cancelled).toHaveBeenCalledOnce();
  fetcher.mockClear();
  for (const repo of ["../repo", "acme/..", "acme/repo?evil", "https://evil.test/a"]) await expect(provider.merge({ ...input, repo }, "token")).rejects.toBeInstanceOf(Error);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([409, 500, 302])("provider %s response never becomes merge success", async status => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("rejected", { status })));
  await expect(provider.merge(input, "token")).rejects.toBeInstanceOf(Error);
});
it("transport timeouts propagate without an internal redispatch", async () => {
  const fetcher = vi.fn(async () => { throw new DOMException("Timeout", "TimeoutError"); }); vi.stubGlobal("fetch", fetcher);
  await expect(provider.merge(input, "token")).rejects.toBeInstanceOf(Error); expect(fetcher).toHaveBeenCalledOnce();
});
