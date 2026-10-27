/** @vitest-environment jsdom */
/**
 * safeRedirect (exported from src/lib/routes.ts and tested directly there;
 * Next forbids extra exports from a page file) and the /auth bounce
 * decisions (tested through the page).
 *
 * safeRedirect takes searchParams.get("redirect") (decoded once) and
 * returns it unchanged, or null. One case per input with the rule that
 * wins: (a) null/empty, (b) a bad char in the raw value (control, DEL,
 * whitespace, backslash), (c) after one decodeURIComponent: a throw, a bad
 * char, a `//` prefix, or a `//` in the decoded path part, (d) the raw
 * value must start with exactly one `/`, (e) no `.`/`..` segment in the
 * decoded path, (f) the allowlist: `/invite/` or a `/projects/<id>` hub
 * location (path and query, no fragment); everything else null.
 *
 * The page: a signed-in user is bounced immediately only to an /invite/
 * target; a /projects/ target goes to /home or /onboarding (loop guard:
 * that 401 may answer 401 again). Only a real submit may use a /projects/
 * target.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Team, User } from "../../src/lib/api";

const search = vi.hoisted(() => ({ current: "" }));
const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams(search.current),
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getProjects: vi.fn(),
  login: vi.fn(),
  register: vi.fn(),
  discoverSso: vi.fn(),
}));

import AuthPage from "../../src/app/auth/page";
import { safeRedirect } from "../../src/lib/routes";
import { getCurrentUser, getProjects, getTeams, login, register } from "../../src/lib/api";

const USER = { id: "u-1", login: "lan" } as User;
const TEAM = { id: "t1", name: "Team", slug: "team", role: "ADMIN", createdAt: "x" } as Team;

beforeEach(() => {
  vi.clearAllMocks();
  search.current = "";
  vi.mocked(getCurrentUser).mockResolvedValue(null);
  vi.mocked(getTeams).mockResolvedValue([TEAM]);
  vi.mocked(getProjects).mockResolvedValue([]);
});
afterEach(cleanup);

describe("safeRedirect accepted (returned unchanged)", () => {
  it.each([
    ["/projects/p1"],
    ["/projects/p1/board"],
    ["/projects/p1/board?taskId=t1&view=list"],
    ["/invite/abc"],
  ])("%s", (value) => {
    expect(safeRedirect(value)).toBe(value);
  });
});

// One row per input, labelled with the rule that wins (the first rule that
// rejects it, in order a-f).
describe("safeRedirect rejected", () => {
  it("null (rule a: null/empty)", () => {
    expect(safeRedirect(null)).toBeNull();
  });

  it.each([
    ["rule a: empty", ""],
    ["rule d: no leading slash", "projects/p1"],
    ["rule f: /projects without an id segment", "/projects"],
    ["rule f: empty id segment fails [^/?#]+", "/projects/"],
    ["rule c: // in the decoded path part", "/projects//evil.com"],
    ["rule c: decoded starts with //", "//evil.com"],
    ["rule b: raw backslash", "/\\evil.com"],
    ["rule b: raw backslash in a project path", "/projects\\x"],
    ["rule c: backslash after decoding", "/projects/%5Cx"],
    ["rule c: // after decoding (strict path part)", "/projects/%2F%2Fevil"],
    ["rule e: dot-dot segment in the decoded path", "/projects/../auth"],
    ["rule e: encoded dot-dot segment", "/projects/%2e%2e/x"],
    ["rule e: mixed-case encoded dot-dot", "/projects/p1/%2e%2E/x"],
    ["rule c: absolute URL has // in its path part", "https://e.com"],
    ["rule d: scheme, no leading slash", "javascript:alert(1)"],
    ["rule b: literal tab", "/projects/p1\t"],
    ["rule c: CRLF after decoding", "/projects/p1/%0d%0a"],
    ["rule c: decodeURIComponent throws", "/projects/%zz"],
    ["rule f: no fragment allowed", "/projects/p1/board#x"],
    ["rule f: not on the allowlist", "/home"],
    ["rule f: not on the allowlist (tasks)", "/tasks"],
    ["rule f: not on the allowlist (other)", "/other"],
    ["resolves to itself: encoded ? hides dot segments", "/projects/p1%3f/../../settings"],
    ["resolves to itself: encoded # hides dot segments", "/projects/p1%23/../../auth"],
    ["resolves to itself: encoded ? in an invite path", "/invite/x%3F/../../home"],
    ["resolves to itself: encoded ? then //", "/projects/p1%3F/../..//evil.com"],
  ])("%s", (_label, value) => {
    expect(safeRedirect(value)).toBeNull();
  });
});

describe("/auth bounce for an already signed-in user (loop guard)", () => {
  it("a /projects/ target is NOT used: /home instead, never the target", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(USER);
    search.current = "redirect=/projects/p1/board";
    render(<AuthPage />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/home"));
    expect(routerMocks.replace).toHaveBeenCalledTimes(1);
    expect(routerMocks.replace).not.toHaveBeenCalledWith("/projects/p1/board");
  });

  it("an /invite/ target is bounced to immediately (unchanged)", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(USER);
    search.current = "redirect=/invite/abc";
    render(<AuthPage />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/invite/abc"));
    expect(routerMocks.replace).toHaveBeenCalledTimes(1);
  });
});

describe("/auth redirect after an actual login submit", () => {
  async function submit() {
    await userEvent.type(await screen.findByLabelText("Email"), "a@b.co");
    await userEvent.type(screen.getByLabelText("Password"), "password123");
    await userEvent.click(screen.getByRole("button", { name: /^Sign in$/ }));
  }

  it("a /projects/ target (query included) is used after a successful login", async () => {
    // The value arrives query-encoded in a real URL; get() returns it decoded.
    search.current = `redirect=${encodeURIComponent("/projects/p1/board?taskId=t1&view=list")}`;
    vi.mocked(login).mockResolvedValue(undefined as never);
    render(<AuthPage />);
    await submit();
    await waitFor(() =>
      expect(routerMocks.replace).toHaveBeenCalledWith("/projects/p1/board?taskId=t1&view=list"),
    );
    expect(routerMocks.replace).toHaveBeenCalledTimes(1);
  });

  it("a /projects/ target is used after a successful register too", async () => {
    search.current = `redirect=${encodeURIComponent("/projects/p1/board")}`;
    vi.mocked(register).mockResolvedValue(undefined as never);
    render(<AuthPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Create one" }));
    await userEvent.type(screen.getByLabelText("Email"), "a@b.co");
    await userEvent.type(screen.getByLabelText("Password"), "password123");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/projects/p1/board"));
    expect(routerMocks.replace).toHaveBeenCalledTimes(1);
  });

  it("a rejected target falls back to /home", async () => {
    search.current = "redirect=//evil.com";
    vi.mocked(login).mockResolvedValue(undefined as never);
    render(<AuthPage />);
    await submit();
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/home"));
    expect(routerMocks.replace).not.toHaveBeenCalledWith("//evil.com");
  });
});
