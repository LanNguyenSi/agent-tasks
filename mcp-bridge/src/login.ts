import { stdin as input, stderr, stdout } from "node:process";
import type { TokenStore } from "./token-store.js";

export interface LoginOptions {
  baseUrl: string;
  store: TokenStore;
  tokenFromArg?: string | undefined;
}

/**
 * Read a token from stdin with real character masking.
 *
 * On a TTY: put stdin in raw mode, read byte-by-byte, echo `*` per printable
 * char, handle Backspace/Ctrl-C/Enter. On failure (non-TTY, no setRawMode,
 * exception mid-read) we fall back to a line read with a visibility warning —
 * fake masking is worse than honest echo.
 */
function promptHiddenToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!input.isTTY || typeof input.setRawMode !== "function") {
      stderr.write(
        "warning: stdin is not a TTY — reading one line without masking.\n",
      );
      let buf = "";
      let settled = false;
      const detach = () => {
        input.off("data", onData);
        input.off("end", onEnd);
        input.off("error", onErr);
      };
      const settle = (err: Error | null, value?: string) => {
        if (settled) return;
        settled = true;
        detach();
        if (err) reject(err);
        else resolve((value ?? "").trim());
      };
      const onData = (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl >= 0) settle(null, buf.slice(0, nl));
      };
      const onEnd = () => settle(null, buf);
      const onErr = (err: Error) => settle(err);
      input.on("data", onData);
      input.on("end", onEnd);
      input.on("error", onErr);
      input.resume();
      return;
    }

    stderr.write("Paste your agent-tasks token (hidden): ");
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");

    let entered = "";
    let settled = false;

    const cleanup = (err: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      input.off("data", onKey);
      try {
        input.setRawMode(false);
      } catch {
        // ignore
      }
      input.pause();
      stderr.write("\n");
      if (err) reject(err);
      else resolve((value ?? "").trim());
    };

    const onKey = (chunk: string) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (ch === "\r" || ch === "\n") {
          cleanup(null, entered);
          return;
        }
        if (code === 3) {
          // Ctrl-C
          cleanup(new Error("Login cancelled"));
          return;
        }
        if (code === 4) {
          // Ctrl-D (EOF)
          cleanup(entered.length === 0 ? new Error("Login cancelled") : null, entered);
          return;
        }
        if (code === 127 || code === 8) {
          // Backspace / DEL
          if (entered.length > 0) {
            entered = entered.slice(0, -1);
            stderr.write("\b \b");
          }
          continue;
        }
        if (code < 32) continue; // ignore other control chars
        entered += ch;
        stderr.write("*");
      }
    };

    input.on("data", onKey);
  });
}

function sanitizeForLog(message: string): string {
  // Strip query strings from any URL to avoid leaking accidentally-embedded secrets.
  return message.replace(/(https?:\/\/[^\s?]+)\?[^\s]*/gi, "$1?[redacted]");
}

async function validateToken(baseUrl: string, token: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/projects/available`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
  } catch (err) {
    throw new Error(
      `Token validation request failed: ${sanitizeForLog((err as Error).message)}`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `Token validation failed: HTTP ${res.status}. Check the token and base URL.`,
    );
  }
  // Sanity check the body shape so an accidentally-public endpoint cannot
  // silently accept a bogus token.
  const body = (await res.json().catch(() => null)) as unknown;
  const ok =
    Array.isArray(body) ||
    (body !== null && typeof body === "object" && "projects" in (body as object));
  if (!ok) {
    throw new Error(
      "Token validation response did not match expected shape; refusing to store.",
    );
  }
}

export async function runLogin(options: LoginOptions): Promise<void> {
  if (options.store.kind === "env") {
    stderr.write(
      "AGENT_TASKS_TOKEN is set in the environment; login is not needed (and cannot overwrite an env token). Unset it first to store in the keychain.\n",
    );
    return;
  }

  const token =
    options.tokenFromArg && options.tokenFromArg.length > 0
      ? options.tokenFromArg
      : await promptHiddenToken();
  if (!token) {
    throw new Error("No token provided.");
  }
  if (/\s/.test(token)) {
    throw new Error(
      "Token contains whitespace or newlines — pasted input may have been truncated. Re-run login and ensure the whole token is on a single line.",
    );
  }
  if (token.length < 16) {
    throw new Error(
      "Token is suspiciously short (<16 chars) — refusing to store. Check that the whole token was captured.",
    );
  }

  await validateToken(options.baseUrl, token);
  await options.store.set(token);
  stderr.write(
    `Token stored via ${options.store.kind} store. Run 'agent-tasks-mcp-bridge status' to verify.\n`,
  );
}

export async function runLogout(store: TokenStore): Promise<void> {
  if (store.kind === "env") {
    stderr.write(
      "Token is provided by AGENT_TASKS_TOKEN env var; unset it in your shell to log out. Nothing to clear in the keychain.\n",
    );
    return;
  }
  await store.clear();
  stderr.write("Token cleared.\n");
}

export async function runStatus(
  baseUrl: string,
  store: TokenStore,
): Promise<void> {
  const token = await store.get();
  if (!token) {
    stderr.write(`No token stored (${store.kind}). Run 'login' first.\n`);
    process.exitCode = 1;
    return;
  }
  try {
    await validateToken(baseUrl, token);
    stdout.write(`ok (store: ${store.kind})\n`);
  } catch (err) {
    stderr.write(
      `Token present (${store.kind}) but validation failed: ${sanitizeForLog((err as Error).message)}\n`,
    );
    process.exitCode = 1;
  }
}
