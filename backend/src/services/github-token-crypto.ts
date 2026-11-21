/**
 * Encryption at rest for GitHub OAuth tokens (`User.githubAccessToken`).
 *
 * The column holds a versioned, self-describing string:
 *
 *   v1:<iv>:<tag>:<ciphertext>      (each part base64url, iv 12 bytes, tag 16 bytes)
 *
 * Cipher: AES-256-GCM.
 *
 * Key: `GITHUB_TOKEN_ENCRYPTION_KEY` when it is set and non-empty, otherwise
 * `SESSION_SECRET`. Either value is fed through HKDF-SHA256 with a fixed info
 * string that names this purpose, so the AES key never equals the session
 * secret or any other key derived from the same value. Changing whichever
 * value is in effect makes every stored token unreadable: `decryptGithubToken`
 * then returns null, the user counts as "GitHub not connected" and connects
 * again. Nothing about a stored value is ever logged.
 *
 * A stored value without the `v1:` prefix is a token from before encryption
 * (GitHub tokens start with `gho_`, `ghp_` or `github_pat_`, never with
 * `v1:`). It is still accepted as is. `readGithubToken` rewrites it encrypted
 * on its first use and the start-up sweep (`startLegacyGithubTokenSweep`)
 * rewrites the rest.
 *
 * The SSO secret key (`SSO_ENCRYPTION_KEY`, `sso-crypto.ts`) is separate and
 * unaffected.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";

const PREFIX = "v1:";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HKDF_INFO = "agent-tasks github-access-token aes-256-gcm v1";

/** The two inputs the key is derived from. Defaults to the backend config. */
export type GithubTokenKeySource = {
  GITHUB_TOKEN_ENCRYPTION_KEY?: string;
  SESSION_SECRET?: string;
};

function deriveKey(source: GithubTokenKeySource): Buffer | null {
  const material = source.GITHUB_TOKEN_ENCRYPTION_KEY || source.SESSION_SECRET;
  if (!material) return null;
  return Buffer.from(hkdfSync("sha256", material, Buffer.alloc(0), HKDF_INFO, KEY_BYTES));
}

export function isEncryptedGithubToken(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

/** Encrypts a token for storage. Throws when no key material is configured. */
export function encryptGithubToken(plain: string, source: GithubTokenKeySource = config): string {
  const key = deriveKey(source);
  if (!key) {
    throw new Error("GITHUB_TOKEN_ENCRYPTION_KEY (or SESSION_SECRET) must be set to store GitHub tokens");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${[iv, tag, ciphertext].map((part) => part.toString("base64url")).join(":")}`;
}

/**
 * The stored value as a usable token, or null when there is none or it cannot
 * be read (wrong or missing key, tampered or malformed value). A value without
 * the version prefix is legacy plaintext and is returned as it is. Pure: no
 * database access, nothing logged.
 */
export function decryptGithubToken(
  stored: string | null | undefined,
  source: GithubTokenKeySource = config,
): string | null {
  if (!stored) return null;
  if (!isEncryptedGithubToken(stored)) return stored;
  const parts = stored.split(":");
  if (parts.length !== 4) return null;
  const key = deriveKey(source);
  if (!key) return null;
  const iv = Buffer.from(parts[1]!, "base64url");
  const tag = Buffer.from(parts[2]!, "base64url");
  const ciphertext = Buffer.from(parts[3]!, "base64url");
  // Exact lengths, checked here and not left to authTagLength alone: a
  // truncated tag must never be accepted, whatever the Node version does.
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return plain || null;
  } catch {
    return null;
  }
}

type UpdateManyArgs = { where: { id: string; githubAccessToken: string }; data: { githubAccessToken: string } };
type TokenClient = { user: { updateMany: (args: UpdateManyArgs) => Promise<{ count: number } | unknown> } };

/**
 * Rewrites one legacy plaintext value encrypted: a compare-and-swap on the
 * value the caller read, so it is idempotent and never replaces a token
 * another request wrote in between (a reconnect or a sign-in). True when this
 * call wrote the row. Throws on a database error or when no key is configured.
 */
async function rewriteLegacy(
  client: TokenClient,
  user: { id: string },
  stored: string,
  plain: string,
  source: GithubTokenKeySource = config,
): Promise<boolean> {
  const result = await client.user.updateMany({
    where: { id: user.id, githubAccessToken: stored },
    data: { githubAccessToken: encryptGithubToken(plain, source) },
  });
  return (result as { count?: number } | null)?.count === 1;
}

/**
 * Rewrites a legacy plaintext value encrypted when `stored` is one. Best
 * effort: a failure is neither logged nor thrown, the next use or the
 * start-up sweep tries again. Not for use inside a caller's transaction: a
 * failed statement would abort that transaction and the row may be locked by
 * it.
 */
export async function rewriteLegacyGithubToken(
  user: { id: string },
  stored: string | null | undefined,
  client: TokenClient = prisma,
): Promise<void> {
  if (!stored || isEncryptedGithubToken(stored)) return;
  try {
    await rewriteLegacy(client, user, stored, stored);
  } catch {
    // Left as it is; retried on the next use.
  }
}

/**
 * The user's usable GitHub token, or null ("not connected"). A legacy
 * plaintext value is rewritten encrypted on this first use (see
 * `rewriteLegacyGithubToken`).
 */
export async function readGithubToken(
  user: { id: string; githubAccessToken: string | null },
  client: TokenClient = prisma,
): Promise<string | null> {
  const stored = user.githubAccessToken;
  const plain = decryptGithubToken(stored);
  if (plain) await rewriteLegacyGithubToken(user, stored, client);
  return plain;
}

type SweepClient = TokenClient & {
  user: {
    findMany: (args: {
      where: object;
      orderBy: { id: "asc" };
      take: number;
      select: { id: true; githubAccessToken: true };
    }) => Promise<Array<{ id: string; githubAccessToken: string | null }>>;
  };
};

export type GithubTokenSweepResult = { skipped: boolean; rewritten: number; failed: number };

export const GITHUB_TOKEN_SWEEP_BATCH_SIZE = 100;

/**
 * One pass over every row whose token is set and not in the encrypted form,
 * in batches ordered by id (a cursor on id, so rows that stay as they are,
 * such as an empty string, do not stop the pass). Each row goes through the
 * same compare-and-swap as `readGithubToken`, so a second instance sweeping
 * at the same time, a restart, or a reconnect in between never overwrites a
 * newer value. Skipped entirely when no key material is configured.
 */
export async function sweepLegacyGithubTokens(
  client: SweepClient = prisma,
  source: GithubTokenKeySource = config,
  batchSize: number = GITHUB_TOKEN_SWEEP_BATCH_SIZE,
): Promise<GithubTokenSweepResult> {
  const result: GithubTokenSweepResult = { skipped: false, rewritten: 0, failed: 0 };
  if (!deriveKey(source)) return { ...result, skipped: true };
  let after: string | undefined;
  for (;;) {
    const rows = await client.user.findMany({
      where: {
        githubAccessToken: { not: null },
        NOT: { githubAccessToken: { startsWith: PREFIX } },
        ...(after === undefined ? {} : { id: { gt: after } }),
      },
      orderBy: { id: "asc" },
      take: batchSize,
      select: { id: true, githubAccessToken: true },
    });
    for (const row of rows) {
      const stored = row.githubAccessToken;
      // The query already left out encrypted rows; an empty value stays as it is.
      if (!stored) continue;
      try {
        if (await rewriteLegacy(client, row, stored, stored, source)) result.rewritten += 1;
      } catch {
        result.failed += 1;
      }
    }
    if (rows.length < batchSize) return result;
    after = rows[rows.length - 1]!.id;
  }
}

/**
 * Starts the sweep without waiting for it: the server serves while it runs.
 * Logs counts only, never a token value or a database error text.
 */
export function startLegacyGithubTokenSweep(client: SweepClient = prisma): void {
  sweepLegacyGithubTokens(client)
    .then(({ skipped, rewritten, failed }) => {
      if (skipped) return;
      if (rewritten > 0 || failed > 0) {
        logger.info({ rewritten, failed }, "GitHub token sweep finished");
      }
    })
    .catch(() => {
      logger.error("GitHub token sweep stopped: the database query failed; tokens are encrypted on first use");
    });
}
