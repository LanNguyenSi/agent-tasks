/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ThemePreferenceField from "../../src/components/ThemePreferenceField";
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

describe("ThemePreferenceField", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
  });

  it("renders three radios and applies the resolved system theme by default", async () => {
    mockMatchMedia(true);
    render(<ThemePreferenceField />);
    const radios = await screen.findAllByRole("radio");
    expect(radios).toHaveLength(3);
    const checked = radios.find((r) => r.getAttribute("aria-checked") === "true");
    expect(checked?.getAttribute("data-theme-pref")).toBe("system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("selecting a value persists it and applies the resolved theme immediately", async () => {
    mockMatchMedia(false);
    render(<ThemePreferenceField />);
    await screen.findAllByRole("radio");
    const user = userEvent.setup();

    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    await user.click(screen.getByRole("radio", { name: "Light" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    await user.click(screen.getByRole("radio", { name: "System" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  });

  it("restores a stored preference on mount", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    mockMatchMedia(true);
    render(<ThemePreferenceField />);
    const radios = await screen.findAllByRole("radio");
    const checked = radios.find((r) => r.getAttribute("aria-checked") === "true");
    expect(checked?.getAttribute("data-theme-pref")).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("falls back to system when stored value is invalid", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "neon");
    mockMatchMedia(true);
    render(<ThemePreferenceField />);
    const radios = await screen.findAllByRole("radio");
    const checked = radios.find((r) => r.getAttribute("aria-checked") === "true");
    expect(checked?.getAttribute("data-theme-pref")).toBe("system");
  });

  it("follows live system changes while pref is 'system'", async () => {
    const mq = mockMatchMedia(false);
    render(<ThemePreferenceField />);
    await screen.findAllByRole("radio");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    act(() => mq.fire(true));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
