// Laying out team work on a calendar: each open card covers the days from its
// start date to its due date. All dates are YYYY-MM-DD strings.

export interface Dated {
  startDate: string | null
  dueDate: string | null
}

export interface Span {
  start: string
  end: string
  /** Started but with no end date: shown running up to today. */
  openEnded: boolean
}

const parse = (date: string) => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}
const iso = (date: Date) => date.toISOString().slice(0, 10)

export function addDays(date: string, days: number): string {
  const value = parse(date)
  value.setUTCDate(value.getUTCDate() + days)
  return iso(value)
}

/** Days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000)
}

/** The Monday of the week `date` falls in. */
export function startOfWeek(date: string): string {
  const day = parse(date).getUTCDay()
  return addDays(date, -((day + 6) % 7))
}

export function isWeekend(date: string): boolean {
  const day = parse(date).getUTCDay()
  return day === 0 || day === 6
}

/** `count` days in a row from `from`. */
export function dayRange(from: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(from, i))
}

/**
 * The days a card covers, or null when it has no dates. A card with only a
 * due date covers that day. A card that has started but has no end runs up to
 * today, since someone is still on it.
 */
export function cardSpan(card: Dated, today: string): Span | null {
  const { startDate, dueDate } = card
  if (startDate && dueDate) {
    return startDate <= dueDate
      ? { start: startDate, end: dueDate, openEnded: false }
      : { start: dueDate, end: startDate, openEnded: false }
  }
  if (dueDate) return { start: dueDate, end: dueDate, openEnded: false }
  if (startDate)
    return {
      start: startDate,
      end: startDate < today ? today : startDate,
      openEnded: true,
    }
  return null
}

export interface Placed<T> {
  item: T
  span: Span
  /** Index of the first and last shown day; the span may run past either side. */
  from: number
  to: number
  /** Row within the person's lane, so overlapping cards stack. */
  lane: number
  clippedStart: boolean
  clippedEnd: boolean
}

/**
 * Place items on the days from `first` for `count` days, stacking overlapping
 * ones into lanes (first free lane wins). Items outside the range are left out.
 */
export function layoutLanes<T>(
  items: { item: T; span: Span }[],
  first: string,
  count: number,
): { placed: Placed<T>[]; lanes: number } {
  const last = addDays(first, count - 1)
  const visible = items
    .filter(({ span }) => span.end >= first && span.start <= last)
    .sort((a, b) =>
      a.span.start === b.span.start ? b.span.end.localeCompare(a.span.end) : a.span.start.localeCompare(b.span.start),
    )
  const laneEnds: number[] = []
  const placed = visible.map(({ item, span }) => {
    const from = Math.max(0, daysBetween(first, span.start))
    const to = Math.min(count - 1, daysBetween(first, span.end))
    let lane = laneEnds.findIndex((end) => end < from)
    if (lane === -1) lane = laneEnds.length
    laneEnds[lane] = to
    return {
      item,
      span,
      from,
      to,
      lane,
      clippedStart: span.start < first,
      clippedEnd: span.end > last,
    }
  })
  return { placed, lanes: laneEnds.length }
}

/** How many items cover each of the `count` days from `first`. */
export function countPerDay(spans: Span[], first: string, count: number): number[] {
  const counts = new Array<number>(count).fill(0)
  for (const span of spans) {
    const from = Math.max(0, daysBetween(first, span.start))
    const to = Math.min(count - 1, daysBetween(first, span.end))
    for (let i = from; i <= to; i++) counts[i]++
  }
  return counts
}

/** The weeks (Monday to Sunday) that show the month of `date`: 4 to 6 rows of 7 days. */
export function monthWeeks(date: string): string[][] {
  const month = date.slice(0, 7)
  const weeks: string[][] = []
  for (let monday = startOfWeek(`${month}-01`); monday.slice(0, 7) <= month; monday = addDays(monday, 7)) {
    weeks.push(dayRange(monday, 7))
  }
  return weeks
}

/** The same day in the month `months` away, clamped to that month's length, e.g. Jan 31 + 1 → Feb 28. */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const target = new Date(Date.UTC(y, m - 1 + months, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(d, lastDay))
  return iso(target)
}

const format = (date: string, options: Intl.DateTimeFormatOptions) =>
  parse(date).toLocaleDateString(undefined, { ...options, timeZone: 'UTC' })

export const formatMonth = (date: string) => format(date, { month: 'long', year: 'numeric' })
export const formatWeekday = (date: string) => format(date, { weekday: 'short' })
export const formatDayMonth = (date: string) => format(date, { month: 'short', day: 'numeric' })
export const formatLongDay = (date: string) => format(date, { weekday: 'long', month: 'long', day: 'numeric' })
