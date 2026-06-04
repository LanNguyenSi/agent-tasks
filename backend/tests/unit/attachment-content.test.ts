/**
 * Unit tests for the attachment read-content service. Uses real temp files
 * (node env) rather than mocking fs, so the partial-read + base64 paths are
 * exercised for real.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readAttachmentContent,
  parseIncludeBase64Flag,
  parseReadByteLimit,
  ATTACHMENT_READ_BASE64_MAX,
} from "../../src/services/attachment-content.js";

let dir: string;
const files: Record<string, string> = {};

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "att-content-"));
  files.text = path.join(dir, "notes.txt");
  files.csv = path.join(dir, "data.csv");
  files.png = path.join(dir, "shot.png");
  await writeFile(files.text, "Hello,   world\n\nsecond line", "utf8");
  await writeFile(files.csv, "a,b\n1,2\n", "utf8");
  // 64 zero bytes is enough to be a deterministic "image" payload for base64.
  await writeFile(files.png, Buffer.alloc(64, 0));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseIncludeBase64Flag", () => {
  it("accepts boolean and the truthy string forms", () => {
    expect(parseIncludeBase64Flag(true)).toBe(true);
    expect(parseIncludeBase64Flag("true")).toBe(true);
    expect(parseIncludeBase64Flag("1")).toBe(true);
    expect(parseIncludeBase64Flag("yes")).toBe(true);
    expect(parseIncludeBase64Flag("false")).toBe(false);
    expect(parseIncludeBase64Flag(undefined)).toBe(false);
    expect(parseIncludeBase64Flag("0")).toBe(false);
  });
});

describe("parseReadByteLimit", () => {
  it("returns the fallback for an omitted value", () => {
    expect(parseReadByteLimit(undefined, 10, 20, "limit")).toEqual({
      ok: true,
      value: 10,
    });
  });

  it("accepts a positive integer within the max", () => {
    expect(parseReadByteLimit("12", 10, 20, "limit")).toEqual({
      ok: true,
      value: 12,
    });
  });

  it("rejects non-integer and over-max values", () => {
    expect(parseReadByteLimit("abc", 10, 20, "limit")).toEqual({
      ok: false,
      message: "limit must be a positive integer no greater than 20",
    });
    expect(parseReadByteLimit("21", 10, 20, "limit")).toEqual({
      ok: false,
      message: "limit must be a positive integer no greater than 20",
    });
  });
});

describe("readAttachmentContent — text", () => {
  it("returns a utf-8 excerpt with whitespace collapsed", async () => {
    const r = await readAttachmentContent(files.text, "text/plain");
    expect(r.status).toBe("ready");
    expect(r.encoding).toBe("utf-8");
    expect(r.text).toContain("Hello,");
    expect(r.excerpt).toBe("Hello, world second line");
    expect(r.truncated).toBe(false);
    expect(r.fileSize).toBeGreaterThan(0);
    expect(r.base64).toBeNull();
  });

  it("truncates when the file exceeds the text byte limit", async () => {
    const r = await readAttachmentContent(files.text, "text/plain", { textByteLimit: 5 });
    expect(r.status).toBe("ready");
    expect(r.truncated).toBe(true);
    expect(r.bytesRead).toBe(5);
    expect(r.text!.length).toBeLessThanOrEqual(5);
  });

  it("accepts a string-form byte limit (the route passes raw query strings)", async () => {
    const r = await readAttachmentContent(files.text, "text/plain", { textByteLimit: "3" });
    expect(r.status).toBe("ready");
    expect(r.truncated).toBe(true);
    expect(r.bytesRead).toBe(3);
  });

  it("handles text/csv and includes base64 when requested", async () => {
    const r = await readAttachmentContent(files.csv, "text/csv", { includeBase64: true });
    expect(r.status).toBe("ready");
    expect(r.encoding).toBe("utf-8");
    expect(r.base64Included).toBe(true);
    expect(Buffer.from(r.base64!, "base64").toString("utf8")).toBe("a,b\n1,2\n");
  });
});

describe("readAttachmentContent — image", () => {
  it("returns base64 only when includeBase64 is set", async () => {
    const r = await readAttachmentContent(files.png, "image/png", { includeBase64: true });
    expect(r.status).toBe("ready");
    expect(r.encoding).toBe("base64");
    expect(r.text).toBeNull();
    expect(r.base64Included).toBe(true);
    expect(r.base64).toBe(Buffer.alloc(64, 0).toString("base64"));
    expect(r.bytesRead).toBe(64);
  });

  it("omits base64 unless requested", async () => {
    const r = await readAttachmentContent(files.png, "image/png");
    expect(r.status).toBe("ready");
    expect(r.base64).toBeNull();
    expect(r.base64Included).toBe(false);
    expect(r.base64Truncated).toBe(false);
  });

  it("flags base64Truncated when the file exceeds the base64 limit", async () => {
    const r = await readAttachmentContent(files.png, "image/png", {
      includeBase64: true,
      base64ByteLimit: 8,
    });
    expect(r.base64).toBeNull();
    expect(r.base64Included).toBe(false);
    expect(r.base64Truncated).toBe(true);
  });

  it("treats the base64 limit as a cap on returned base64 characters", async () => {
    const base64Length = Buffer.alloc(64, 0).toString("base64").length;
    const r = await readAttachmentContent(files.png, "image/png", {
      includeBase64: true,
      base64ByteLimit: base64Length - 1,
    });
    expect(r.base64Included).toBe(false);
    expect(r.base64).toBeNull();
    expect(r.base64Truncated).toBe(true);
  });

  it("still accepts a large but in-range base64 limit", async () => {
    const r = await readAttachmentContent(files.png, "image/png", {
      includeBase64: true,
      base64ByteLimit: ATTACHMENT_READ_BASE64_MAX,
    });
    expect(r.base64Included).toBe(true);
  });
});

describe("readAttachmentContent — edge cases", () => {
  it("returns missing for a null path (URL-pointer attachment)", async () => {
    const r = await readAttachmentContent(null, "text/plain");
    expect(r.status).toBe("missing");
    expect(r.fileSize).toBeNull();
  });

  it("returns missing for a nonexistent file", async () => {
    const r = await readAttachmentContent(path.join(dir, "gone.txt"), "text/plain");
    expect(r.status).toBe("missing");
  });

  it("returns unsupported for a disallowed mime type", async () => {
    const r = await readAttachmentContent(files.png, "application/pdf");
    expect(r.status).toBe("unsupported");
    expect(r.encoding).toBeNull();
  });

  it("treats a null/empty mime type as unsupported", async () => {
    const r = await readAttachmentContent(files.text, null);
    expect(r.status).toBe("unsupported");
  });

  it("returns error when the path stats but cannot be read (directory → EISDIR)", async () => {
    const subdir = path.join(dir, "a-dir");
    await mkdir(subdir, { recursive: true });
    const r = await readAttachmentContent(subdir, "text/plain");
    expect(r.status).toBe("error");
    expect(r.fileSize).not.toBeNull();
  });
});
