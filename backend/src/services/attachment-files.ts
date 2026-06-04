/**
 * File-attachment helpers: MIME allowlist, magic-byte content sniffing,
 * filename + storage-path safety, and the on-disk upload directory.
 *
 * Storage model: the bytes live on a disk volume (UPLOAD_DIR), the DB holds
 * metadata only. Adapted from triologue's upload/serve approach (Express +
 * multer) to our Hono backend, with the deliberate hardening that the served
 * media type comes from a magic-byte sniff, never the client Content-Type.
 *
 * SVG, PDF and JSON are intentionally NOT allowed in v1: SVG can carry
 * embedded JavaScript (stored-XSS), and PDF/JSON are out of scope.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";

/** Hard per-file cap: 5 MiB, applied to image and text alike. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * Whole-request ceiling for the multipart upload, enforced by a `bodyLimit`
 * before the body is buffered. Sits above MAX_ATTACHMENT_BYTES to leave room
 * for multipart framing and the optional `name` field; the real per-file cap
 * is re-checked after parsing.
 */
export const ATTACHMENT_BODY_LIMIT_BYTES = MAX_ATTACHMENT_BYTES + 512 * 1024;

export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export const TEXT_MIME_TYPES = ["text/plain", "text/markdown", "text/csv"] as const;
export const ALLOWED_MIME_TYPES = [...IMAGE_MIME_TYPES, ...TEXT_MIME_TYPES] as const;

export type AttachmentKind = "IMAGE" | "DOCUMENT";

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
};

export type DetectResult =
  | { ok: true; mimeType: string; kind: AttachmentKind; ext: string }
  | { ok: false; reason: string };

/** Bare, lowercased media type from a raw `Content-Type` value (drops params). */
export function normalizeMime(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.split(";")[0]!.trim().toLowerCase();
}

/**
 * Sniff one of the four allowed image media types from the leading magic
 * bytes, or null if the buffer is not a recognized image.
 */
export function sniffImageMime(buf: Buffer): string | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  // GIF: "GIF87a" or "GIF89a"
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return "image/gif";
  }
  // WEBP: "RIFF" .... "WEBP"
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** Valid UTF-8 with no NUL byte: our bar for "this is really a text file". */
function isUtf8Text(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether a buffer may be stored, using a magic-byte sniff rather than
 * the client-declared Content-Type:
 *
 * - Declared image type: the sniffed signature MUST match exactly. A mismatch
 *   (wrong image type, or bytes that are not an image at all) is rejected.
 * - Declared text type: the bytes must NOT be a recognized image and must be
 *   valid UTF-8 text.
 * - Anything else (svg, pdf, json, application/*, unknown): rejected outright.
 *
 * The returned `mimeType` is the authoritative type to store and later serve.
 */
export function detectAttachmentType(buf: Buffer, declaredMimeRaw: string | null | undefined): DetectResult {
  const declared = normalizeMime(declaredMimeRaw);
  const isImageDeclared = (IMAGE_MIME_TYPES as readonly string[]).includes(declared);
  const isTextDeclared = (TEXT_MIME_TYPES as readonly string[]).includes(declared);

  if (!isImageDeclared && !isTextDeclared) {
    return {
      ok: false,
      reason: `Unsupported file type: ${declared || "unknown"}. Allowed: ${ALLOWED_MIME_TYPES.join(", ")}`,
    };
  }

  const sniffed = sniffImageMime(buf);

  if (isImageDeclared) {
    if (sniffed === null) {
      return { ok: false, reason: `Declared ${declared} but the file contents are not a recognized image` };
    }
    if (sniffed !== declared) {
      return { ok: false, reason: `Declared ${declared} but the file contents are ${sniffed}` };
    }
    return { ok: true, mimeType: sniffed, kind: "IMAGE", ext: EXT_BY_MIME[sniffed]! };
  }

  // Declared text.
  if (sniffed !== null) {
    return { ok: false, reason: `Declared ${declared} but the file contents are an image (${sniffed})` };
  }
  if (!isUtf8Text(buf)) {
    return { ok: false, reason: `Declared ${declared} but the file contents are not valid UTF-8 text` };
  }
  return { ok: true, mimeType: declared, kind: "DOCUMENT", ext: EXT_BY_MIME[declared]! };
}

/** Drop C0 control characters (0x00–0x1F) and DEL (0x7F) from a string. */
function stripControlChars(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code > 0x1f && code !== 0x7f) out += ch;
  }
  return out;
}

/**
 * Display name shown in the UI. Strips control chars and path separators,
 * collapses to a fallback when empty, and caps length. This NEVER becomes the
 * on-disk filename (that is a random UUID), so it cannot drive path traversal.
 */
export function sanitizeDisplayName(raw: string | null | undefined, fallback = "upload"): string {
  const cleaned = stripControlChars((raw ?? "").toString())
    .replace(/[/\\]/g, "_")
    .trim();
  const name = cleaned.length > 0 ? cleaned : fallback;
  return name.slice(0, 255);
}

/** Random, collision-free, traversal-proof on-disk filename for a stored upload. */
export function storedFilename(uuid: string, ext: string): string {
  return `${uuid}${ext}`;
}

/** Absolute upload directory. UPLOAD_DIR in containers; `./uploads` otherwise. */
export function uploadDir(): string {
  const fromEnv = process.env.UPLOAD_DIR;
  return path.resolve(fromEnv && fromEnv.length > 0 ? fromEnv : "uploads");
}

/** Ensure the upload directory exists; returns its absolute path. */
export async function ensureUploadDir(): Promise<string> {
  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Resolve a stored attachment `url` (`/uploads/<file>`) to an absolute path
 * inside UPLOAD_DIR, or null if it is a URL-pointer attachment or the value
 * tries to escape the directory. Defends against tampered DB rows even though
 * stored filenames are UUIDs by construction.
 */
export function storedFilePath(url: string): string | null {
  const prefix = "/uploads/";
  if (!url.startsWith(prefix)) return null;
  const name = url.slice(prefix.length);
  if (name.length === 0 || name.includes("/") || name.includes("\\") || name.includes("..")) {
    return null;
  }
  const dir = uploadDir();
  const abs = path.resolve(dir, name);
  if (path.dirname(abs) !== dir) return null;
  return abs;
}

/** Keep only printable ASCII (0x20–0x7E), with quotes/backslash neutralized. */
function asciiHeaderSafe(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    out += code >= 0x20 && code <= 0x7e && ch !== '"' && ch !== "\\" ? ch : "_";
  }
  return out;
}

/** `Content-Disposition` value: inline for images, attachment for text. */
export function contentDisposition(kind: AttachmentKind, name: string): string {
  const disposition = kind === "IMAGE" ? "inline" : "attachment";
  // RFC 5987 ext-value: percent-encode, then also escape the chars
  // encodeURIComponent leaves but attr-char disallows ( ' ( ) * ).
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
  return `${disposition}; filename="${asciiHeaderSafe(name)}"; filename*=UTF-8''${encoded}`;
}
