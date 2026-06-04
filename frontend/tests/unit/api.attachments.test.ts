/**
 * Tests the REAL attachment API helpers (no module mock) so the core upload
 * contract is exercised: FormData body, no hand-set Content-Type (the browser
 * adds the multipart boundary), credentials included, correct URL, and that a
 * backend `{ error }` envelope surfaces as the human-readable message.
 *
 * Runs in the default node environment; undici provides global fetch/File/
 * FormData (Node 18+).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { uploadTaskAttachmentFile, rawAttachmentUrl, ApiRequestError } from "../../src/lib/api";

const realFetch = globalThis.fetch;

function mockFetchOnce(impl: () => Partial<Response> & { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  const fn = vi.fn().mockResolvedValue(impl());
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("rawAttachmentUrl", () => {
  it("builds an absolute /raw URL under the API base", () => {
    expect(rawAttachmentUrl("task-1", "att-9")).toMatch(/\/api\/tasks\/task-1\/attachments\/att-9\/raw$/);
  });
});

describe("uploadTaskAttachmentFile", () => {
  it("POSTs multipart FormData with credentials and no hand-set Content-Type", async () => {
    const created = { id: "a-1", taskId: "task-1", name: "shot.png", url: "/uploads/x.png", mimeType: "image/png", sizeBytes: 4, type: "IMAGE", createdByUserId: "u1", createdAt: "2026-06-04T00:00:00Z" };
    const fetchFn = mockFetchOnce(() => ({ ok: true, status: 201, json: async () => ({ attachment: created }) }));

    const file = new File([new Uint8Array([1, 2, 3, 4])], "shot.png", { type: "image/png" });
    const result = await uploadTaskAttachmentFile("task-1", file, "Shot");

    expect(result).toEqual(created);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/tasks\/task-1\/attachments\/upload$/);
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    // No Content-Type header: the browser must set the multipart boundary.
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    const body = init.body as FormData;
    expect(body.get("file")).toBeInstanceOf(File);
    expect((body.get("file") as File).name).toBe("shot.png");
    expect(body.get("name")).toBe("Shot");
  });

  it("omits the name field when not provided", async () => {
    const fetchFn = mockFetchOnce(() => ({ ok: true, json: async () => ({ attachment: {} }) }));
    const file = new File([new Uint8Array([1])], "a.txt", { type: "text/plain" });
    await uploadTaskAttachmentFile("task-1", file);
    const init = (fetchFn.mock.calls[0] as [string, RequestInit])[1];
    expect((init.body as FormData).get("name")).toBeNull();
  });

  it("surfaces the backend { error } reason as the thrown message", async () => {
    const reason = "Declared image/png but the file contents are not a recognized image";
    mockFetchOnce(() => ({ ok: false, status: 400, json: async () => ({ error: reason }) }));
    const file = new File([new Uint8Array([1])], "fake.png", { type: "image/png" });

    await expect(uploadTaskAttachmentFile("task-1", file)).rejects.toThrow(reason);
    await expect(uploadTaskAttachmentFile("task-1", file)).rejects.toBeInstanceOf(ApiRequestError);
  });
});
