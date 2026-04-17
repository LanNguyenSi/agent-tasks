/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ThemeToggle from "../../src/components/ThemeToggle";
import { THEME_STORAGE_KEY, resolveTheme } from "../../src/lib/theme";

function mockMatchMedia(prefersDark: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches: prefersDark,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  };
  window.matchMedia = vi.fn().mockReturnValue(mql);
  return {
    fire(prefDark: boolean) {
      mql.matches = prefDark;
      listeners.forEach((cb) => cb({ matches: prefDark } as MediaQueryListEvent));
    },
  };
}

describe("resolveTheme", () => {
  it("returns the explicit preference when set", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("falls back to system preference for 'system'", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("ThemeToggle", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
  });

  it("defaults to system and applies resolved theme from matchMedia", async () => {
    mockMatchMedia(true);
    render(<ThemeToggle />);
    const btn = await screen.findByRole("button");
    expect(btn).toHaveAttribute("data-theme-pref", "system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("cycles system → light → dark → system and persists the choice", async () => {
    mockMatchMedia(false);
    render(<ThemeToggle />);
    const btn = await screen.findByRole("button");
    const user = userEvent.setup();

    await user.click(btn);
    expect(btn).toHaveAttribute("data-theme-pref", "light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    await user.click(btn);
    expect(btn).toHaveAttribute("data-theme-pref", "dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    await user.click(btn);
    expect(btn).toHaveAttribute("data-theme-pref", "system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  });

  it("restores a stored preference on mount", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    mockMatchMedia(true);
    render(<ThemeToggle />);
    const btn = await screen.findByRole("button");
    expect(btn).toHaveAttribute("data-theme-pref", "light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("falls back to system when stored value is invalid", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "neon");
    mockMatchMedia(true);
    render(<ThemeToggle />);
    const btn = await screen.findByRole("button");
    expect(btn).toHaveAttribute("data-theme-pref", "system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("follows live system changes while pref is 'system'", async () => {
    const mq = mockMatchMedia(false);
    render(<ThemeToggle />);
    await screen.findByRole("button");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    act(() => mq.fire(true));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
