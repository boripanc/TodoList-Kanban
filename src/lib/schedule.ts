// Cards labelled R4C or Project are pieces of work with a planned span, so
// they need both a start date and an end date (the end date is the card's
// due date). The app warns about missing dates; the API refuses them.
import { formatDue } from './dates'

/** Label names (compared without case) whose cards need a start and end date. */
export const DATE_RANGE_LABELS = ['r4c', 'project']

export function needsDateRange(labelNames: string[]): boolean {
  return labelNames.some((name) => DATE_RANGE_LABELS.includes(name.trim().toLowerCase()))
}

export interface Schedule {
  startDate: string | null
  /** The end date. */
  dueDate: string | null
}

/**
 * What is wrong with a card's dates, or null when nothing is. `labelNames`
 * are the names of the card's labels.
 */
export function scheduleProblem(card: Schedule, labelNames: string[]): string | null {
  if (card.startDate && card.dueDate && card.startDate > card.dueDate) return 'The start date is after the end date.'
  if (!needsDateRange(labelNames)) return null
  const label = labelNames.find((name) => DATE_RANGE_LABELS.includes(name.trim().toLowerCase()))!.trim()
  if (!card.startDate && !card.dueDate) return `${label} cards need a start date and an end date.`
  if (!card.startDate) return `${label} cards need a start date.`
  if (!card.dueDate) return `${label} cards need an end date.`
  return null
}

/** "Oct 20 – Oct 26" style text for a card's dates; null when it has neither. */
export function formatSchedule(card: Schedule, now: Date = new Date()): string | null {
  if (card.startDate && card.dueDate) return `${formatDue(card.startDate, now)} – ${formatDue(card.dueDate, now)}`
  if (card.startDate) return `From ${formatDue(card.startDate, now)}`
  if (card.dueDate) return formatDue(card.dueDate, now)
  return null
}
