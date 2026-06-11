"use client";

import { useEffect, useRef, useState } from "react";
import {
  applyResolvedTheme,
  isThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemePreference,
} from "../lib/theme";

const OPTIONS: { value: ThemePreference; label: string; hint: string }[] = [
  { value: "system", label: "System", hint: "Match OS preference" },
  { value: "light", label: "Light", hint: "Always light" },
  { value: "dark", label: "Dark", hint: "Always dark" },
];

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
    // localStorage can throw in private mode -- fall back to system.
  }
  return "system";
}

export default function ThemePreferenceField() {
  const [preference, setPreference] = useState<ThemePreference>("system");
  const [resolved, setResolved] = useState<ResolvedTheme>("dark");
  const [mounted, setMounted] = useState(false);
  const groupRef = useRef<HTMLDivElement>(null);

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

  function pick(next: ThemePreference) {
    const nextResolved = resolveTheme(next, readSystemPrefersDark());
    setPreference(next);
    setResolved(nextResolved);
    applyResolvedTheme(nextResolved);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore storage failures -- theme still applies for this session.
    }
  }

  // Arrow key navigation within the radiogroup (ArrowLeft/Right cycle).
  function handleGroupKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const currentIdx = OPTIONS.findIndex((o) => o.value === preference);
    const nextIdx =
      e.key === "ArrowRight"
        ? (currentIdx + 1) % OPTIONS.length
        : (currentIdx - 1 + OPTIONS.length) % OPTIONS.length;
    const nextOpt = OPTIONS[nextIdx];
    if (nextOpt) {
      pick(nextOpt.value);
      // Move DOM focus to the newly activated radio.
      const btn = groupRef.current?.querySelector<HTMLElement>(
        `[data-theme-pref="${nextOpt.value}"]`,
      );
      btn?.focus();
    }
  }

  const activePref = mounted ? preference : "system";

  return (
    <div role="radiogroup" aria-label="Theme preference" data-testid="theme-preference">
      <div
        ref={groupRef}
        className="view-toggle theme-toggle"
        onKeyDown={handleGroupKeyDown}
      >
        {OPTIONS.map((opt) => {
          const active = opt.value === activePref;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => pick(opt.value)}
              title={opt.hint}
              className={active ? "view-toggle-active" : undefined}
              data-theme-pref={opt.value}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      <p className="theme-hint">
        {activePref === "system"
          ? `Following your operating system (currently ${resolved}).`
          : `Using ${activePref} theme.`}
      </p>
    </div>
  );
}
