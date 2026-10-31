/** @vitest-environment jsdom */
/**
 * /auth/error?reason=<code>: the consumer side of the backend redirects.
 *
 * - every reason code a backend producer emits renders its own message;
 * - an unknown, empty or malformed code renders the generic fallback and a
 *   value outside the forwarded charset is never echoed as the reference;
 * - the page reads `reason` only (the old `error` parameter is ignored);
 * - producer parity: every literal reason in backend/src/routes/auth.ts and
 *   backend/src/routes/sso.ts has a message of its own.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, cleanup } from "@testing-library/react";

const search = vi.hoisted(() => ({ current: "" }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search.current),
}));

import AuthErrorPage from "../../src/app/auth/error/page";
import {
  GENERIC_AUTH_ERROR_MESSAGE,
  KNOWN_AUTH_ERROR_REASONS,
  authErrorMessage,
  referenceFor,
} from "../../src/app/auth/error/messages";

function renderPage(query: string) {
  search.current = query;
  return render(<AuthErrorPage />);
}

afterEach(() => {
  cleanup();
  search.current = "";
});

describe("authErrorMessage", () => {
  it.each(KNOWN_AUTH_ERROR_REASONS)("%s has its own message", (reason) => {
    const message = authErrorMessage(reason);
    expect(message).not.toBe(GENERIC_AUTH_ERROR_MESSAGE);
    expect(message.length).toBeGreaterThan(20);
  });

  it("gives every known reason a distinct message unless it is a deliberate alias", () => {
    const aliases = new Set([
      "server_error:temporarily_unavailable",
      "login_required:consent_required",
      "login_required:interaction_required",
      "consent_required:interaction_required",
    ]);
    const seen = new Map<string, string>();
    for (const reason of KNOWN_AUTH_ERROR_REASONS) {
      const message = authErrorMessage(reason);
      const other = seen.get(message);
      if (other) expect(aliases.has(`${other}:${reason}`)).toBe(true);
      else seen.set(message, reason);
    }
  });

  it.each([null, "", "totally_unknown", "ACCESS_DENIED", "constructor", "__proto__", "toString"])(
    "%j → generic fallback",
    (reason) => {
      expect(authErrorMessage(reason)).toBe(GENERIC_AUTH_ERROR_MESSAGE);
    },
  );

  it("a malformed code never selects a message, even with a known code inside", () => {
    expect(authErrorMessage("access_denied<b>")).toBe(GENERIC_AUTH_ERROR_MESSAGE);
    expect(authErrorMessage("access_denied ")).toBe(GENERIC_AUTH_ERROR_MESSAGE);
  });
});

describe("referenceFor", () => {
  it.each([
    [null, null],
    ["", null],
    ["access_denied", "access_denied"],
    ["some-new_code1", "some-new_code1"],
    ["a".repeat(40), "a".repeat(40)],
    ["a".repeat(41), null],
    ["<script>", null],
    ["a b", null],
    ["a\nb", null],
  ])("%j → %j", (input, expected) => {
    expect(referenceFor(input)).toBe(expected);
  });
});

describe("/auth/error page", () => {
  it.each(KNOWN_AUTH_ERROR_REASONS)("?reason=%s renders its message and the reference", (reason) => {
    renderPage(`reason=${reason}`);
    expect(screen.getByRole("heading", { name: "Authentication failed" })).toBeTruthy();
    expect(screen.getByText(authErrorMessage(reason))).toBeTruthy();
    expect(screen.getByText(reason, { selector: "code" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Try again" }).getAttribute("href")).toBe("/auth");
  });

  it("an unknown but well-formed code renders the fallback and shows the code as the reference", () => {
    renderPage("reason=brand_new_code");
    expect(screen.getByText(GENERIC_AUTH_ERROR_MESSAGE)).toBeTruthy();
    expect(screen.getByText("brand_new_code", { selector: "code" })).toBeTruthy();
  });

  it("no reason → fallback and no reference line", () => {
    const { container } = renderPage("");
    expect(screen.getByText(GENERIC_AUTH_ERROR_MESSAGE)).toBeTruthy();
    expect(container.querySelector("code")).toBeNull();
  });

  it("a malformed reason renders the fallback and is not echoed", () => {
    const { container } = renderPage(`reason=${encodeURIComponent('<img src=x onerror="alert(1)">')}`);
    expect(screen.getByText(GENERIC_AUTH_ERROR_MESSAGE)).toBeTruthy();
    expect(container.querySelector("code")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toContain("onerror");
  });

  it("reads reason only: the legacy ?error= parameter is ignored", () => {
    const { container } = renderPage("error=access_denied");
    expect(screen.getByText(GENERIC_AUTH_ERROR_MESSAGE)).toBeTruthy();
    expect(container.querySelector("code")).toBeNull();
  });

  it("reason wins when both parameters are present", () => {
    renderPage("error=callback_failed&reason=sso_failed");
    expect(screen.getByText(authErrorMessage("sso_failed"))).toBeTruthy();
  });
});

describe("producer parity with the backend redirects", () => {
  // Code only: `//` comment lines may mention the URL shape.
  const read = (file: string) =>
    readFileSync(resolve(__dirname, "../../../backend/src/routes", file), "utf8")
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n");

  // A full literal producer: the whole forwarded charset up to the closing quote.
  const DIRECT = /\/auth\/error\?reason=([A-Za-z0-9_-]+)[`"']/g;
  // The two documented interpolated producers (sso.ts `safe`, auth.ts helper `reason`).
  const INTERPOLATED = /\/auth\/error\?reason=\$\{(?:safe|reason)\}`/g;
  const HELPER = /redirectToAuthError\(c, "([A-Za-z0-9_-]+)"\)/g;

  const direct = (src: string) => [...src.matchAll(DIRECT)].map((m) => m[1]!);
  const helper = (src: string) => [...src.matchAll(HELPER)].map((m) => m[1]!);
  const count = (src: string, re: RegExp) => [...src.matchAll(re)].length;
  const occurrences = (src: string) => count(src, /\/auth\/error/g);

  it("finds the literal reasons the backend can redirect with", () => {
    const sso = direct(read("sso.ts"));
    const gh = [...direct(read("auth.ts")), ...helper(read("auth.ts"))];
    // Guard against the regexes silently matching nothing.
    expect(new Set(sso)).toEqual(
      new Set([
        "sso_unavailable",
        "bad_request",
        "state_mismatch",
        "sso_not_configured",
        "not_provisioned",
        "sso_failed",
      ]),
    );
    expect(new Set(gh)).toEqual(
      new Set(["bad_request", "state_mismatch", "session_mismatch", "callback_failed"]),
    );
  });

  it("every /auth/error occurrence is a recognised producer form (unknown forms fail loudly)", () => {
    const sso = read("sso.ts");
    const auth = read("auth.ts");
    expect(count(sso, INTERPOLATED)).toBe(1);
    expect(count(auth, INTERPOLATED)).toBe(1);
    expect(occurrences(sso)).toBe(direct(sso).length + count(sso, INTERPOLATED));
    expect(occurrences(auth)).toBe(direct(auth).length + count(auth, INTERPOLATED));
  });

  it("every literal reason a backend producer emits has a message of its own", () => {
    const literals = new Set<string>([
      ...direct(read("sso.ts")),
      ...direct(read("auth.ts")),
      ...helper(read("auth.ts")),
    ]);
    expect(literals.size).toBeGreaterThan(0);
    for (const reason of literals) {
      expect(KNOWN_AUTH_ERROR_REASONS).toContain(reason);
    }
  });

  it("access_denied, the provider code both callbacks forward, has a message of its own", () => {
    expect(KNOWN_AUTH_ERROR_REASONS).toContain("access_denied");
  });

  it("the legacy ?error= producer is gone from both backend callbacks", () => {
    expect(read("sso.ts")).not.toMatch(/auth\/error\?error=/);
    expect(read("auth.ts")).not.toMatch(/auth\/error\?error=/);
    expect(read("auth.ts")).not.toMatch(/auth\/error`/);
  });
});
