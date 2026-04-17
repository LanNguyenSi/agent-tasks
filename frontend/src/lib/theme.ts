export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "agent-tasks:theme";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

export function resolveTheme(pref: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (pref === "light" || pref === "dark") return pref;
  return systemPrefersDark ? "dark" : "light";
}

export function applyResolvedTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.style.colorScheme = resolved;
}

/**
 * Inline snippet injected into <head> to resolve and apply the theme
 * before first paint. Stays inline (no import) so the DOM never flashes
 * the wrong theme during hydration.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var k='${THEME_STORAGE_KEY}';var v=null;try{v=localStorage.getItem(k);}catch(e){}var sys=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';var r=(v==='light'||v==='dark')?v:sys;var d=document.documentElement;d.setAttribute('data-theme',r);d.style.colorScheme=r;}catch(e){}})();`;
