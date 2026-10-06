export type DueStatus = 'overdue' | 'today' | 'soon' | 'later'

/** Today's local date as YYYY-MM-DD. */
export function todayISO(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Whole days from today to the given YYYY-MM-DD date (negative when past). */
export function daysUntil(date: string, now: Date = new Date()): number {
  const [y, m, d] = date.split('-').map(Number)
  const target = Date.UTC(y, m - 1, d)
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((target - today) / 86_400_000)
}

export function dueStatus(date: string, now: Date = new Date()): DueStatus {
  const days = daysUntil(date, now)
  if (days < 0) return 'overdue'
  if (days === 0) return 'today'
  if (days <= 2) return 'soon'
  return 'later'
}

export function formatDue(date: string, now: Date = new Date()): string {
  const days = daysUntil(date, now)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days === -1) return 'Yesterday'
  const [y, m, d] = date.split('-').map(Number)
  const value = new Date(y, m - 1, d)
  return value.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: y === now.getFullYear() ? undefined : 'numeric',
  })
}
