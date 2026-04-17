"use client";

import { useEffect, useState } from "react";
import {
  applyResolvedTheme,
  isThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemePreference,
} from "../lib/theme";

interface ThemeToggleProps {
  className?: string;
}

const ORDER: ThemePreference[] = ["system", "light", "dark"];

const LABEL: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

const ICON: Record<ThemePreference, string> = {
  system: "🖥",
  light: "☀",
  dark: "☾",
};

function readSystemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemePreference(raw)) return raw;
  } catch {
    // localStorage can throw in private mode — fall back to system.
  }
  return "system";
}

export default function ThemeToggle({ className }: ThemeToggleProps) {
  const [preference, setPreference] = useState<ThemePreference>("system");
  const [resolved, setResolved] = useState<ResolvedTheme>("dark");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const pref = readStoredPreference();
    const next = resolveTheme(pref, readSystemPrefersDark());
    setPreference(pref);
    setResolved(next);
    applyResolvedTheme(next);
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    if (preference !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (event: MediaQueryListEvent) => {
      const next: ResolvedTheme = event.matches ? "dark" : "light";
      setResolved(next);
      applyResolvedTheme(next);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [mounted, preference]);

  function cycle() {
    const idx = ORDER.indexOf(preference);
    const nextPref = ORDER[(idx + 1) % ORDER.length];
    const nextResolved = resolveTheme(nextPref, readSystemPrefersDark());
    setPreference(nextPref);
    setResolved(nextResolved);
    applyResolvedTheme(nextResolved);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextPref);
    } catch {
      // Ignore storage failures — theme still applies for this session.
    }
  }

  const label = mounted ? LABEL[preference] : LABEL.system;
  const icon = mounted ? ICON[preference] : ICON.system;
  const ariaLabel = `Theme: ${label}${preference === "system" ? ` (resolved to ${resolved})` : ""}. Click to change.`;

  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={ariaLabel}
      title={ariaLabel}
      className={className}
      data-theme-pref={preference}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4rem",
        border: "1px solid var(--border)",
        background: "transparent",
        color: "var(--muted)",
        borderRadius: "8px",
        padding: "0.3rem 0.55rem",
        fontSize: "0.85rem",
        lineHeight: 1,
      }}
    >
      <span aria-hidden="true" style={{ fontSize: "0.95rem" }}>{icon}</span>
      <span style={{ color: "var(--text)" }}>{label}</span>
    </button>
  );
}
