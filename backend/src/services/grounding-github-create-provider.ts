import { z } from "zod";
import { canonicalGithubRepo } from "./grounding-github-fence.js";

const name = z.string().regex(/^[A-Za-z0-9_.-]+$/).refine(value => value !== "." && value !== "..");
const branch = z.string().min(1).max(255).refine(value => ![...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || ["~", "^", ":", "?", "*", "[", "\\"].includes(char)) && !value.includes("..") && !value.includes("@{") && !value.includes("//") && !value.startsWith("/") && !value.endsWith("/") && !value.endsWith(".") && value.split("/").every(part => !part.startsWith(".") && !part.endsWith(".lock")));
const head = z.string().min(1).max(511).refine(value => {
  const pieces = value.split(":");
  return pieces.length === 1 ? branch.safeParse(value).success : pieces.length === 2 && name.safeParse(pieces[0]).success && branch.safeParse(pieces[1]).success;
});
export const githubCreateRequestSchema = z.object({ owner: name, repo: name, head, base: branch.default("main"), title: z.string().min(1).max(4096), body: z.string().max(65536).default("") }).strict();
export type GithubCreateRequest = z.infer<typeof githubCreateRequestSchema>;
export function normalizeGithubCreateRequest(input: unknown): GithubCreateRequest {
  const request = githubCreateRequestSchema.parse(input);
  const [owner, repo] = canonicalGithubRepo(`${request.owner}/${request.repo}`).split("/") as [string, string];
  const parts = request.head.split(":");
  return { ...request, owner, repo, head: parts.length === 2 ? `${parts[0]!.toLowerCase()}:${parts[1]}` : request.head };
}
export function githubCreateCorrelationMarker(operationId: string): string {
  return `<!-- agent-tasks:pr-create:${z.string().uuid().parse(operationId)} -->`;
}
export function hasGithubCreateCorrelation(raw: unknown, operationId: string): boolean {
  const parsed = z.object({ body: z.string().max(65700) }).safeParse(raw);
  return parsed.success && parsed.data.body.endsWith(`\n\n${githubCreateCorrelationMarker(operationId)}`);
}

export interface GithubCreateProof {
  repo: string; number: number; url: string; title: string;
  sourceRepo: string; headRef: string; headSha: string; baseRef: string;
}
const repoName = z.string().refine(value => { try { canonicalGithubRepo(value); return true; } catch { return false; } });
const rawProofSchema = z.object({
  number: z.number().int().positive().max(2147483647), html_url: z.string().max(1024), title: z.string().max(4096),
  head: z.object({ label: z.string().max(511), ref: branch, sha: z.string().regex(/^[0-9a-f]{40}$/), repo: z.object({ full_name: repoName, owner: z.object({ login: name }) }) }),
  base: z.object({ ref: branch, repo: z.object({ full_name: repoName }) }),
});
export function githubCreateProof(request: GithubCreateRequest, raw: unknown, operationId: string): GithubCreateProof | null {
  if (!hasGithubCreateCorrelation(raw, operationId)) return null;
  const parsed = rawProofSchema.safeParse(raw); if (!parsed.success) return null;
  const proof = parsed.data; const repo = `${request.owner}/${request.repo}`;
  const parts = request.head.split(":"); const sourceOwner = parts.length === 2 ? parts[0]! : request.owner;
  const headRef = parts.length === 2 ? parts[1]! : request.head;
  const sourceRepo = canonicalGithubRepo(proof.head.repo.full_name);
  const label = proof.head.label.split(":");
  const url = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/.exec(proof.html_url);
  if (!url || !repoName.safeParse(url[1]).success || canonicalGithubRepo(url[1]!) !== repo || url[2] !== String(proof.number) || canonicalGithubRepo(proof.base.repo.full_name) !== repo || proof.base.ref !== request.base ||
    proof.head.ref !== headRef || sourceRepo.split("/")[0] !== sourceOwner || proof.head.repo.owner.login.toLowerCase() !== sourceOwner ||
    (label.length !== 2 || label[0]!.toLowerCase() !== sourceOwner || label[1] !== headRef) || (parts.length === 1 && sourceRepo !== repo)) return null;
  return { repo, number: proof.number, url: `https://github.com/${repo}/pull/${proof.number}`, title: proof.title, sourceRepo, headRef, headSha: proof.head.sha, baseRef: proof.base.ref };
}

export interface GroundingGithubCreateProvider {
  create(request: GithubCreateRequest, token: string, operationId: string): Promise<unknown>;
  read(request: GithubCreateRequest, token: string, operationId: string): Promise<{ complete: boolean; pullRequests: unknown[] }>;
}
async function requestJson(url: string, token: string, body?: object): Promise<{ response: Response; value: unknown }> {
  if (!token) throw new Error("GitHub create provider unavailable");
  const response = await fetch(url, { method: body ? "POST" : "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "Cache-Control": "no-cache" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok || !response.body) throw new Error("GitHub create provider unavailable");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.length;
      if (length > 262144) { await reader.cancel(); throw new Error("GitHub create provider unavailable"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return { response, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) };
}
/** One bounded POST or read. Pagination never counts as a complete reconciliation. */
export const githubGroundingCreateProvider: GroundingGithubCreateProvider = {
  async create(input, token, operationId) {
    const request = normalizeGithubCreateRequest(input);
    return (await requestJson(`https://api.github.com/repos/${request.owner}/${request.repo}/pulls`, token, { head: request.head, base: request.base, title: request.title, body: `${request.body}\n\n${githubCreateCorrelationMarker(operationId)}` })).value;
  },
  async read(input, token, operationId) {
    githubCreateCorrelationMarker(operationId);
    const request = normalizeGithubCreateRequest(input);
    const qualifiedHead = request.head.includes(":") ? request.head : `${request.owner}:${request.head}`;
    const query = new URLSearchParams({ state: "all", head: qualifiedHead, base: request.base, per_page: "100" });
    const { response, value } = await requestJson(`https://api.github.com/repos/${request.owner}/${request.repo}/pulls?${query}`, token);
    if (!Array.isArray(value) || value.length > 100) throw new Error("GitHub create provider unavailable");
    return { complete: value.length < 100 && !response.headers.get("link")?.includes('rel="next"'), pullRequests: value };
  },
};
