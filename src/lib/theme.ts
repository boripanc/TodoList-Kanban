export type Theme = 'system' | 'light' | 'dark'

const THEME_KEY = 'todolist-kanban/theme'

export function loadTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_KEY)
    if (value === 'light' || value === 'dark' || value === 'system') return value
  } catch {
    // Storage blocked; use the system theme.
  }
  return 'system'
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement
  if (theme === 'system') delete root.dataset.theme
  else root.dataset.theme = theme
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // Storage blocked; the choice lasts for this visit only.
  }
}

export const nextTheme: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' }
export const themeIcon: Record<Theme, string> = { system: '🖥', light: '☀️', dark: '🌙' }
