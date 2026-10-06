import { describe, expect, it } from 'vitest'
import type { Card } from '../types'
import { emptyFilter, isFilterActive, matchesFilter } from './filter'
import { dueStatus, formatDue, todayISO } from './dates'

const now = new Date(2026, 9, 6, 12) // 6 Oct 2026, local noon

function card(patch: Partial<Card> = {}): Card {
  return {
    id: 'c',
    title: 'Plan sprint',
    description: 'Talk to the team',
    labelIds: [],
    priority: 'none',
    dueDate: null,
    checklist: [],
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }
}

describe('matchesFilter', () => {
  it('matches everything with an empty filter', () => {
    expect(isFilterActive(emptyFilter)).toBe(false)
    expect(matchesFilter(card(), emptyFilter, now)).toBe(true)
  })

  it('searches title, notes and checklist items case-insensitively', () => {
    const c = card({ checklist: [{ id: 'i', text: 'Book ROOM', done: false }] })
    expect(matchesFilter(c, { ...emptyFilter, query: 'SPRINT' }, now)).toBe(true)
    expect(matchesFilter(c, { ...emptyFilter, query: 'team' }, now)).toBe(true)
    expect(matchesFilter(c, { ...emptyFilter, query: 'room' }, now)).toBe(true)
    expect(matchesFilter(c, { ...emptyFilter, query: 'invoice' }, now)).toBe(false)
  })

  it('matches any selected label and any selected priority', () => {
    const c = card({ labelIds: ['a'], priority: 'high' })
    expect(matchesFilter(c, { ...emptyFilter, labelIds: ['a', 'b'] }, now)).toBe(true)
    expect(matchesFilter(c, { ...emptyFilter, labelIds: ['b'] }, now)).toBe(false)
    expect(matchesFilter(c, { ...emptyFilter, priorities: ['high', 'urgent'] }, now)).toBe(true)
    expect(matchesFilter(c, { ...emptyFilter, priorities: ['low'] }, now)).toBe(false)
  })

  it('filters by due date', () => {
    const overdue = card({ dueDate: '2026-10-05' })
    const today = card({ dueDate: '2026-10-06' })
    const nextWeek = card({ dueDate: '2026-10-13' })
    const later = card({ dueDate: '2026-10-20' })
    const none = card()
    const due = (d: Card, value: typeof emptyFilter.due) => matchesFilter(d, { ...emptyFilter, due: value }, now)

    expect([overdue, today, nextWeek, later, none].map((c) => due(c, 'overdue'))).toEqual([true, false, false, false, false])
    expect([overdue, today, nextWeek, later, none].map((c) => due(c, 'today'))).toEqual([false, true, false, false, false])
    expect([overdue, today, nextWeek, later, none].map((c) => due(c, 'week'))).toEqual([false, true, true, false, false])
    expect([overdue, today, nextWeek, later, none].map((c) => due(c, 'none'))).toEqual([false, false, false, false, true])
  })
})

describe('dates', () => {
  it('describes due dates relative to today', () => {
    expect(todayISO(now)).toBe('2026-10-06')
    expect(dueStatus('2026-10-05', now)).toBe('overdue')
    expect(dueStatus('2026-10-06', now)).toBe('today')
    expect(dueStatus('2026-10-08', now)).toBe('soon')
    expect(dueStatus('2026-10-20', now)).toBe('later')
    expect(formatDue('2026-10-07', now)).toBe('Tomorrow')
    expect(formatDue('2026-10-05', now)).toBe('Yesterday')
  })
})
