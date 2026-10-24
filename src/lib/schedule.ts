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

// Other cards get their dates from the work itself: the start date is set when
// the card first moves into an in-progress column, and the due date follows
// from the estimate in man-days (MD), counting weekdays only.

const IN_PROGRESS_WORDS = /\b(in[ -]?progress|doing|wip|ongoing|started|working)\b/i

/** A column counts as in progress when its title says so, such as "In progress" or "Doing". */
export function isInProgressColumn(title: string): boolean {
  return IN_PROGRESS_WORDS.test(title)
}

const parse = (date: string) => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}
const iso = (date: Date) => date.toISOString().slice(0, 10)
const weekend = (date: Date) => date.getUTCDay() === 0 || date.getUTCDay() === 6

/**
 * The day a task of `estimateDays` man-days ends when it starts on `start`,
 * counting weekdays only: 1 MD ends the day it starts, 3 MD started on a
 * Thursday end on Monday. Part days count as a whole day.
 */
export function dueFromEstimate(start: string, estimateDays: number): string {
  const day = parse(start)
  while (weekend(day)) day.setUTCDate(day.getUTCDate() + 1)
  for (let left = Math.max(1, Math.ceil(estimateDays)) - 1; left > 0; ) {
    day.setUTCDate(day.getUTCDate() + 1)
    if (!weekend(day)) left--
  }
  return iso(day)
}

export interface Plannable extends Schedule {
  estimateDays: number | null
}

/**
 * The dates a card gets when it moves into `columnTitle` on `today`: a start
 * date of today, and a due date from its estimate. Null when nothing changes:
 * the column isn't in progress, the card already started, or it is an R4C or
 * Project card, whose dates are set by hand.
 */
export function startWorkPatch(
  card: Plannable,
  labelNames: string[],
  columnTitle: string,
  today: string,
): { startDate: string; dueDate?: string } | null {
  if (!isInProgressColumn(columnTitle) || card.startDate || needsDateRange(labelNames)) return null
  return card.estimateDays ? { startDate: today, dueDate: dueFromEstimate(today, card.estimateDays) } : { startDate: today }
}

/** The largest estimate accepted, in man-days. */
export const MAX_ESTIMATE_DAYS = 999
