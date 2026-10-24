import { describe, expect, it } from 'vitest'
import { addDays, addMonths, cardSpan, countPerDay, layoutLanes, monthWeeks, startOfWeek } from './calendar'

const span = (start: string, end: string) => ({ start, end, openEnded: false })

describe('calendar', () => {
  it('finds the Monday of a week', () => {
    expect(startOfWeek('2026-10-24')).toBe('2026-10-19') // Saturday
    expect(startOfWeek('2026-10-25')).toBe('2026-10-19') // Sunday
    expect(startOfWeek('2026-10-19')).toBe('2026-10-19')
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
  })

  it('moves by months, keeping the day inside the month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15')
    expect(addMonths('2026-01-10', -1)).toBe('2025-12-10')
  })

  it('works out the days a card covers', () => {
    const today = '2026-10-24'
    expect(cardSpan({ startDate: '2026-10-20', dueDate: '2026-10-22' }, today)).toEqual(span('2026-10-20', '2026-10-22'))
    expect(cardSpan({ startDate: null, dueDate: '2026-10-22' }, today)).toEqual(span('2026-10-22', '2026-10-22'))
    // Started with no end: still being worked on, so it runs to today.
    expect(cardSpan({ startDate: '2026-10-20', dueDate: null }, today)).toEqual({
      start: '2026-10-20',
      end: today,
      openEnded: true,
    })
    expect(cardSpan({ startDate: '2026-10-30', dueDate: null }, today)?.end).toBe('2026-10-30')
    // Dates the wrong way round still show.
    expect(cardSpan({ startDate: '2026-10-22', dueDate: '2026-10-20' }, today)).toEqual(span('2026-10-20', '2026-10-22'))
    expect(cardSpan({ startDate: null, dueDate: null }, today)).toBeNull()
  })

  it('stacks overlapping cards into lanes and clips them to the range', () => {
    const { placed, lanes } = layoutLanes(
      [
        { item: 'a', span: span('2026-10-15', '2026-10-21') },
        { item: 'b', span: span('2026-10-20', '2026-10-23') },
        { item: 'c', span: span('2026-10-22', '2026-11-30') },
        { item: 'gone', span: span('2026-12-01', '2026-12-02') },
      ],
      '2026-10-19',
      14,
    )
    expect(lanes).toBe(2)
    expect(placed.map((p) => [p.item, p.from, p.to, p.lane, p.clippedStart, p.clippedEnd])).toEqual([
      ['a', 0, 2, 0, true, false],
      ['b', 1, 4, 1, false, false],
      ['c', 3, 13, 0, false, true],
    ])
  })

  it('counts cards per day', () => {
    expect(countPerDay([span('2026-10-19', '2026-10-20'), span('2026-10-20', '2026-10-25')], '2026-10-19', 4)).toEqual([
      1, 2, 1, 1,
    ])
  })

  it('lays out a month in Monday-first weeks', () => {
    const weeks = monthWeeks('2026-10-24')
    expect(weeks).toHaveLength(5)
    expect(weeks[0][0]).toBe('2026-09-28')
    expect(weeks[4][6]).toBe('2026-11-01')
    // February 2021 starts on a Monday and fits in four weeks.
    expect(monthWeeks('2021-02-10')).toHaveLength(4)
  })
})
