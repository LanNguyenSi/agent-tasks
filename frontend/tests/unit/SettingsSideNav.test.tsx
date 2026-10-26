/** @vitest-environment jsdom */
/**
 * /settings side nav: the first section is current at scroll 0 (even when the
 * scroll-spy first reports a later section inside its band), the active link
 * carries aria-current="location", and scrolling moves it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, within } from "@testing-library/react";
import type { User } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getAgentTokens: vi.fn(),
  getAvailableScopes: vi.fn(),
  updateDelegationSettings: vi.fn(),
  getGithubTokenHealth: vi.fn(),
}));

import SettingsPage from "../../src/app/settings/page";
import { getCurrentUser } from "../../src/lib/api";

const mockGetCurrentUser = vi.mocked(getCurrentUser);

type IOCallback = (entries: Array<{ isIntersecting: boolean; target: Element }>) => void;
const spy = vi.hoisted(() => ({ callback: null as null | ((e: unknown[]) => void) }));
class IntersectionObserverStub {
  constructor(cb: (e: unknown[]) => void) {
    spy.callback = cb;
  }
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
}
(global as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
  IntersectionObserverStub;

window.matchMedia = vi.fn().mockReturnValue({
  matches: false,
  media: "",
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => true,
}) as unknown as typeof window.matchMedia;

function report(id: string) {
  const target = document.getElementById(id)!;
  act(() => {
    (spy.callback as unknown as IOCallback)([{ isIntersecting: true, target }]);
  });
}

function navLink(name: string): HTMLElement {
  const nav = screen.getByRole("complementary", { name: "Settings sections" });
  return within(nav).getByRole("link", { name });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue({
    id: "u-1",
    login: "lan",
    name: "Lan",
    avatarUrl: null,
    email: null,
    githubConnected: false,
    allowAgentPrCreate: false,
    allowAgentPrMerge: false,
    allowAgentPrComment: false,
  } as User);
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
});
afterEach(cleanup);

async function renderPage() {
  render(<SettingsPage />);
  await screen.findByRole("heading", { name: "Account" });
}

describe("/settings side nav", () => {
  it("marks Account current before any scroll-spy report", async () => {
    await renderPage();
    expect(navLink("Account").getAttribute("aria-current")).toBe("location");
    expect(navLink("Appearance").hasAttribute("aria-current")).toBe(false);
  });

  it("keeps Account current at scroll 0 when the spy reports Appearance first", async () => {
    await renderPage();
    report("appearance");
    expect(navLink("Account").getAttribute("aria-current")).toBe("location");
    expect(navLink("Account").className).toContain("settings-side-nav-link--active");
    expect(navLink("Appearance").hasAttribute("aria-current")).toBe(false);
  });

  it("follows the spy once the page is scrolled", async () => {
    await renderPage();
    Object.defineProperty(window, "scrollY", { value: 600, configurable: true });
    report("github");
    expect(navLink("GitHub").getAttribute("aria-current")).toBe("location");
    expect(navLink("Account").hasAttribute("aria-current")).toBe(false);
  });
});
