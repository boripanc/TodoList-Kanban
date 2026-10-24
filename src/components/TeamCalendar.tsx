import { useState } from 'react'
import type { Card } from '../types'
import { useStore } from '../state/context'
import { findBoardOfCard } from '../state/reducer'
import { todayISO } from '../lib/dates'
import { formatSchedule } from '../lib/schedule'
import type { MemberLoad, Workload } from '../lib/workload'
import {
  addDays,
  addMonths,
  cardSpan,
  countPerDay,
  dayRange,
  formatDayMonth,
  formatLongDay,
  formatMonth,
  formatWeekday,
  isWeekend,
  layoutLanes,
  monthWeeks,
  startOfWeek,
  type Span,
} from '../lib/calendar'
import { Avatar, AvatarStack } from './Team'

export type CalendarView = 'timeline' | 'month'

/** Days shown in the timeline: two weeks from a Monday. */
const TIMELINE_DAYS = 14
/** Cards listed in a month day before "+N more". */
const MONTH_SHOWN = 3

type Person = Pick<MemberLoad<Card>, 'key' | 'name' | 'color'>
interface Entry {
  card: Card
  span: Span
  people: Person[]
}

interface Props {
  view: CalendarView
  workload: Workload<Card>
  /** Name each card's board, when cards come from several boards. */
  showBoard: boolean
  onOpenCard: (card: Card) => void
  /** For tests; defaults to the real today. */
  today?: string
}

/** Who is busy when: each person's open cards on a timeline or a month grid. */
export function TeamCalendar({ view, workload, showBoard, onOpenCard, today = todayISO() }: Props) {
  const [anchor, setAnchor] = useState(today)
  const [personKey, setPersonKey] = useState<string | null>(null)
  const members = workload.members.filter((m) => !personKey || m.key === personKey)

  const timelineStart = startOfWeek(anchor)
  const step = (direction: number) =>
    setAnchor((a) => (view === 'timeline' ? addDays(a, 7 * direction) : addMonths(a, direction)))
  const title =
    view === 'timeline'
      ? `${formatDayMonth(timelineStart)} – ${formatDayMonth(addDays(timelineStart, TIMELINE_DAYS - 1))}`
      : formatMonth(anchor)

  return (
    <section className="team-calendar" aria-label={view === 'timeline' ? 'Team timeline' : 'Team month'}>
      <div className="calendar-toolbar">
        <button
          type="button"
          className="icon-button"
          aria-label={view === 'timeline' ? 'Previous week' : 'Previous month'}
          onClick={() => step(-1)}
        >
          ‹
        </button>
        <strong className="calendar-title" aria-live="polite">
          {title}
        </strong>
        <button
          type="button"
          className="icon-button"
          aria-label={view === 'timeline' ? 'Next week' : 'Next month'}
          onClick={() => step(1)}
        >
          ›
        </button>
        <button type="button" className="button" onClick={() => setAnchor(today)}>
          Today
        </button>
      </div>
      {workload.members.length > 1 && (
        <div className="calendar-people" role="group" aria-label="Show calendar for">
          <button
            type="button"
            className={`chip ${personKey === null ? 'on' : ''}`}
            aria-pressed={personKey === null}
            onClick={() => setPersonKey(null)}
          >
            Everyone
          </button>
          {workload.members.map((m) => (
            <button
              key={m.key}
              type="button"
              className={`chip chip-person ${personKey === m.key ? 'on' : ''}`}
              aria-pressed={personKey === m.key}
              onClick={() => setPersonKey(personKey === m.key ? null : m.key)}
            >
              <Avatar person={m} small />
              {m.name}
            </button>
          ))}
        </div>
      )}
      {view === 'timeline' ? (
        <Timeline members={members} first={timelineStart} today={today} showBoard={showBoard} onOpenCard={onOpenCard} />
      ) : (
        <Month members={members} anchor={anchor} today={today} showBoard={showBoard} onOpenCard={onOpenCard} />
      )}
    </section>
  )
}

function useCardLabel(showBoard: boolean) {
  const { state } = useStore()
  return (card: Card, extra?: string) =>
    [card.title, formatSchedule(card), showBoard ? findBoardOfCard(state, card.id)?.title : null, extra]
      .filter(Boolean)
      .join(', ')
}

const dayClass = (date: string, today: string) =>
  [isWeekend(date) && 'weekend', date === today && 'today'].filter(Boolean).join(' ')

function Timeline({
  members,
  first,
  today,
  showBoard,
  onOpenCard,
}: {
  members: MemberLoad<Card>[]
  first: string
  today: string
  showBoard: boolean
  onOpenCard: (card: Card) => void
}) {
  const label = useCardLabel(showBoard)
  const days = dayRange(first, TIMELINE_DAYS)
  const columns = { '--days': TIMELINE_DAYS } as React.CSSProperties
  return (
    <div className="timeline-scroll">
      <div className="timeline" role="table" aria-label="Who is busy when">
        <div className="timeline-row timeline-header" role="row" style={columns}>
          <span className="timeline-person" role="columnheader">
            Person
          </span>
          {days.map((d) => (
            <span
              key={d}
              className={`timeline-day ${dayClass(d, today)}`}
              role="columnheader"
              aria-label={formatLongDay(d)}
            >
              <small>{formatWeekday(d)}</small>
              {Number(d.slice(8))}
            </span>
          ))}
        </div>
        {members.map((m) => {
          const items = m.open.flatMap((card) => {
            const span = cardSpan(card, today)
            return span ? [{ item: card, span }] : []
          })
          const { placed, lanes } = layoutLanes(items, first, TIMELINE_DAYS)
          const counts = countPerDay(
            placed.map((p) => p.span),
            first,
            TIMELINE_DAYS,
          )
          const undated = m.open.length - items.length
          return (
            <div key={m.key} className="timeline-row" role="row" aria-label={`Timeline: ${m.name}`} style={columns}>
              <span className="timeline-person" role="rowheader">
                <Avatar person={m} small />
                <span>
                  {m.name}
                  {undated > 0 && <small className="muted"> · {undated} undated</small>}
                </span>
              </span>
              <div
                className="timeline-track"
                role="cell"
                style={{ '--lanes': Math.max(1, lanes) } as React.CSSProperties}
              >
                {days.map((d, i) => (
                  <span
                    key={d}
                    className={`timeline-cell ${dayClass(d, today)} ${counts[i] > 1 ? 'overlap' : ''}`}
                    style={{ gridColumn: i + 1 }}
                    title={counts[i] > 1 ? `${m.name} has ${counts[i]} cards on ${formatLongDay(d)}` : undefined}
                    aria-hidden
                  />
                ))}
                {placed.length === 0 && <span className="timeline-empty muted">Nothing scheduled</span>}
                {placed.map((p) => (
                  <button
                    key={p.item.id}
                    type="button"
                    className={barClass(p.span, p.item, today, p.clippedStart, p.clippedEnd)}
                    style={
                      {
                        gridColumn: `${p.from + 1} / ${p.to + 2}`,
                        gridRow: p.lane + 1,
                        '--avatar': m.color,
                      } as React.CSSProperties
                    }
                    aria-label={label(p.item, p.span.openEnded ? 'no end date' : undefined)}
                    title={label(p.item, p.span.openEnded ? 'no end date' : undefined)}
                    onClick={() => onOpenCard(p.item)}
                  >
                    {p.item.title}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function barClass(span: Span, card: Card, today: string, clippedStart: boolean, clippedEnd: boolean) {
  return [
    'timeline-bar',
    span.openEnded && 'open-ended',
    card.dueDate && card.dueDate < today && 'overdue',
    clippedStart && 'clipped-start',
    clippedEnd && 'clipped-end',
  ]
    .filter(Boolean)
    .join(' ')
}

function Month({
  members,
  anchor,
  today,
  showBoard,
  onOpenCard,
}: {
  members: MemberLoad<Card>[]
  anchor: string
  today: string
  showBoard: boolean
  onOpenCard: (card: Card) => void
}) {
  const label = useCardLabel(showBoard)
  const [selected, setSelected] = useState<string | null>(null)
  const weeks = monthWeeks(anchor)
  const month = anchor.slice(0, 7)

  // Each card once, with the shown people who have it.
  const entries = new Map<string, Entry>()
  for (const m of members) {
    for (const card of m.open) {
      const existing = entries.get(card.id)
      if (existing) {
        existing.people.push(m)
        continue
      }
      const span = cardSpan(card, today)
      if (span) entries.set(card.id, { card, span, people: [m] })
    }
  }
  const list = [...entries.values()].sort((a, b) => a.span.start.localeCompare(b.span.start))
  const onDay = (date: string) => list.filter((e) => e.span.start <= date && e.span.end >= date)
  const entryLabel = ({ card, span, people }: Entry) =>
    label(card, `${people.map((p) => p.name).join(' and ')}${span.openEnded ? ', no end date' : ''}`)
  const selectedCards = selected ? onDay(selected) : []

  return (
    <>
      <div className="month" role="table" aria-label={formatMonth(anchor)}>
        <div className="month-week month-header" role="row">
          {weeks[0].map((d) => (
            <span key={d} role="columnheader">
              {formatWeekday(d)}
            </span>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={week[0]} className="month-week" role="row">
            {week.map((d) => {
              const cards = onDay(d)
              const people = new Map(cards.flatMap((e) => e.people).map((p) => [p.key, p]))
              const count = `${cards.length} card${cards.length === 1 ? '' : 's'}`
              return (
                <div
                  key={d}
                  role="cell"
                  className={[
                    'month-day',
                    dayClass(d, today),
                    d.slice(0, 7) !== month && 'other-month',
                    d === selected && 'selected',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <button
                    type="button"
                    className="month-date"
                    aria-pressed={d === selected}
                    aria-label={`${formatLongDay(d)}: ${count}`}
                    onClick={() => setSelected(d === selected ? null : d)}
                  >
                    <span>{Number(d.slice(8))}</span>
                    <span className="month-dots" aria-hidden>
                      {[...people.values()].map((p) => (
                        <span
                          key={p.key}
                          className="month-dot"
                          style={{ '--avatar': p.color } as React.CSSProperties}
                        />
                      ))}
                    </span>
                  </button>
                  <ul className="month-cards">
                    {cards.slice(0, MONTH_SHOWN).map((entry) => (
                      <li key={entry.card.id}>
                        <button
                          type="button"
                          className={`month-card ${entry.card.dueDate && entry.card.dueDate < today ? 'overdue' : ''}`}
                          style={{ '--avatar': entry.people[0].color } as React.CSSProperties}
                          aria-label={entryLabel(entry)}
                          title={entryLabel(entry)}
                          onClick={() => onOpenCard(entry.card)}
                        >
                          {entry.card.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {cards.length > MONTH_SHOWN && (
                    <button type="button" className="link month-more" onClick={() => setSelected(d)}>
                      +{cards.length - MONTH_SHOWN} more
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>
      {selected && (
        <section className="month-detail" aria-label={`Cards on ${formatLongDay(selected)}`}>
          <h3>{formatLongDay(selected)}</h3>
          {selectedCards.length === 0 ? (
            <p className="muted small">Nobody has a card on this day.</p>
          ) : (
            <ul>
              {selectedCards.map((entry) => (
                <li key={entry.card.id}>
                  <AvatarStack people={entry.people} />
                  <button type="button" className="link" onClick={() => onOpenCard(entry.card)}>
                    {entry.card.title}
                  </button>
                  <small className="muted">{entryLabel(entry).slice(entry.card.title.length + 2)}</small>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  )
}
