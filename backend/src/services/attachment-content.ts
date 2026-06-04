/**
 * Read a stored task attachment as agent-consumable content: a UTF-8 text
 * excerpt for text files, or base64 for images. Adapted from triologue's
 * `attachmentProcessing.ts`, dropping the PDF (poppler) and OCR (tesseract)
 * branches: agent-tasks ships neither binary, and the upload allowlist is only
 * image/* + text/* anyway.
 *
 * The byte caps here are the READ-slice caps for a single agent response; they
 * are unrelated to (and much smaller than) the 5 MiB upload cap.
 */
import { stat, open, readFile } from "node:fs/promises";
import { IMAGE_MIME_TYPES, TEXT_MIME_TYPES, normalizeMime } from "./attachment-files.js";

export const ATTACHMENT_READ_TEXT_DEFAULT = 200_000;
export const ATTACHMENT_READ_TEXT_MAX = 800_000;
export const ATTACHMENT_READ_BASE64_DEFAULT = 64 * 1024;
export const ATTACHMENT_READ_BASE64_MAX = 512_000;

const SUPPORTED_MIME_TYPES: string[] = [...TEXT_MIME_TYPES, ...IMAGE_MIME_TYPES];

export type AttachmentReadStatus = "ready" | "unsupported" | "missing" | "error";

export interface ReadAttachmentOptions {
  includeBase64?: boolean;
  /** Already-validated byte limits. Routes must reject invalid / over-max values. */
  textByteLimit?: unknown;
  base64ByteLimit?: unknown;
}

export interface AttachmentReadResult {
  status: AttachmentReadStatus;
  mimeType: string;
  /** `utf-8` for a text excerpt, `base64` for an image, null when not read. */
  encoding: "utf-8" | "base64" | null;
  text: string | null;
  /** Whitespace-collapsed first ~800 chars of the text, for quick scanning. */
  excerpt: string | null;
  /** True when the text file is larger than the text byte limit. */
  truncated: boolean;
  bytesRead: number;
  fileSize: number | null;
  base64: string | null;
  base64Included: boolean;
  /** True when base64 was requested but the file exceeds the base64 limit. */
  base64Truncated: boolean;
  supportedMimeTypes: string[];
}

function normalizeLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export function parseReadByteLimit(
  value: unknown,
  fallback: number,
  max: number,
  fieldName: string,
): { ok: true; value: number } | { ok: false; message: string } {
  if (value === undefined || value === null || String(value).trim() === "") {
    return { ok: true, value: fallback };
  }

  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) {
    return {
      ok: false,
      message: `${fieldName} must be a positive integer no greater than ${max}`,
    };
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    return {
      ok: false,
      message: `${fieldName} must be a positive integer no greater than ${max}`,
    };
  }

  return { ok: true, value: parsed };
}

function encodedBase64Length(rawBytes: number): number {
  return 4 * Math.ceil(rawBytes / 3);
}

/** Coerce a query-string flag (`1`/`true`/`yes`) or boolean to a boolean. */
export function parseIncludeBase64Flag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function emptyResult(mimeType: string, status: AttachmentReadStatus, fileSize: number | null): AttachmentReadResult {
  return {
    status,
    mimeType,
    encoding: null,
    text: null,
    excerpt: null,
    truncated: false,
    bytesRead: 0,
    fileSize,
    base64: null,
    base64Included: false,
    base64Truncated: false,
    supportedMimeTypes: SUPPORTED_MIME_TYPES,
  };
}

/**
 * Read `absPath` (already validated to live inside UPLOAD_DIR, e.g. via
 * `storedFilePath`) and return its content per the attachment's MIME type.
 * Pass `null` for URL-pointer attachments (no bytes) — yields `missing`.
 */
export async function readAttachmentContent(
  absPath: string | null,
  mimeTypeRaw: string | null | undefined,
  options: ReadAttachmentOptions = {},
): Promise<AttachmentReadResult> {
  const mimeType = normalizeMime(mimeTypeRaw);
  const textByteLimit = normalizeLimit(options.textByteLimit, ATTACHMENT_READ_TEXT_DEFAULT, ATTACHMENT_READ_TEXT_MAX);
  const base64ByteLimit = normalizeLimit(options.base64ByteLimit, ATTACHMENT_READ_BASE64_DEFAULT, ATTACHMENT_READ_BASE64_MAX);
  const includeBase64 = Boolean(options.includeBase64);

  if (!absPath) return emptyResult(mimeType, "missing", null);

  let fileSize: number;
  try {
    fileSize = (await stat(absPath)).size;
  } catch {
    return emptyResult(mimeType, "missing", null);
  }

  const isText = (TEXT_MIME_TYPES as readonly string[]).includes(mimeType);
  const isImage = (IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
  if (!isText && !isImage) {
    return emptyResult(mimeType, "unsupported", fileSize);
  }

  // Optional base64 of the whole file, gated by the encoded base64 length cap.
  // Available for both images (the primary use) and text (when a caller wants
  // raw bytes).
  let base64: string | null = null;
  let base64Included = false;
  let base64Truncated = false;
  if (includeBase64) {
    if (encodedBase64Length(fileSize) <= base64ByteLimit) {
      try {
        base64 = (await readFile(absPath)).toString("base64");
        base64Included = true;
      } catch {
        return emptyResult(mimeType, "error", fileSize);
      }
    } else {
      base64Truncated = true;
    }
  }

  if (isImage) {
    return {
      status: "ready",
      mimeType,
      encoding: "base64",
      text: null,
      excerpt: null,
      truncated: false,
      bytesRead: base64Included ? fileSize : 0,
      fileSize,
      base64,
      base64Included,
      base64Truncated,
      supportedMimeTypes: SUPPORTED_MIME_TYPES,
    };
  }

  // Text: read up to the text byte limit and decode. A partial read can split a
  // multi-byte UTF-8 sequence at the tail; the non-fatal decoder replaces the
  // stray bytes rather than throwing.
  const readLen = Math.min(fileSize, textByteLimit);
  let text: string;
  let bytesRead: number;
  try {
    const fh = await open(absPath, "r");
    try {
      const buf = Buffer.alloc(readLen);
      const res = await fh.read(buf, 0, readLen, 0);
      bytesRead = res.bytesRead;
      text = new TextDecoder("utf-8").decode(buf.subarray(0, bytesRead));
    } finally {
      await fh.close();
    }
  } catch {
    return emptyResult(mimeType, "error", fileSize);
  }

  const excerpt = text.replace(/\s+/g, " ").trim().slice(0, 800) || null;
  return {
    status: "ready",
    mimeType,
    encoding: "utf-8",
    text,
    excerpt,
    truncated: fileSize > textByteLimit,
    bytesRead,
    fileSize,
    base64,
    base64Included,
    base64Truncated,
    supportedMimeTypes: SUPPORTED_MIME_TYPES,
  };
}
