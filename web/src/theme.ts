export type Theme = 'system' | 'light' | 'dark';
const KEY = 'cc.theme';

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    // storage unavailable
  }
  return 'system';
}

/** Applies the theme to <html>; "system" follows the OS setting. */
export function applyTheme(theme: Theme = getTheme()): void {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: Theme): void {
  try {
    if (theme === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // storage unavailable
  }
  applyTheme(theme);
}
