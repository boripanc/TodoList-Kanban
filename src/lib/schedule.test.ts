import { describe, expect, it } from 'vitest'
import {
  dueFromEstimate,
  formatSchedule,
  isInProgressColumn,
  needsDateRange,
  scheduleProblem,
  startWorkPatch,
} from './schedule'

const now = new Date(2026, 9, 24)

describe('schedule', () => {
  it('needs a date range for R4C and Project cards, ignoring case', () => {
    expect(needsDateRange(['R4C'])).toBe(true)
    expect(needsDateRange(['Ticket', ' project '])).toBe(true)
    expect(needsDateRange(['Ticket', 'Projects'])).toBe(false)
    expect(needsDateRange([])).toBe(false)
  })

  it('says which dates are missing or out of order', () => {
    const none = { startDate: null, dueDate: null }
    expect(scheduleProblem(none, ['Ticket'])).toBeNull()
    expect(scheduleProblem(none, ['R4C'])).toBe('R4C cards need a start date and an end date.')
    expect(scheduleProblem({ startDate: '2026-11-01', dueDate: null }, ['Project'])).toBe(
      'Project cards need an end date.',
    )
    expect(scheduleProblem({ startDate: null, dueDate: '2026-11-01' }, ['Project'])).toBe(
      'Project cards need a start date.',
    )
    expect(scheduleProblem({ startDate: '2026-11-02', dueDate: '2026-11-01' }, [])).toBe(
      'The start date is after the end date.',
    )
    expect(scheduleProblem({ startDate: '2026-11-01', dueDate: '2026-11-01' }, ['R4C'])).toBeNull()
  })

  it('formats a range, a start or a due date', () => {
    expect(formatSchedule({ startDate: '2026-11-01', dueDate: '2026-11-15' }, now)).toBe('Nov 1 – Nov 15')
    expect(formatSchedule({ startDate: '2026-11-01', dueDate: null }, now)).toBe('From Nov 1')
    expect(formatSchedule({ startDate: null, dueDate: '2026-10-25' }, now)).toBe('Tomorrow')
    expect(formatSchedule({ startDate: null, dueDate: null }, now)).toBeNull()
  })
})

describe('estimates', () => {
  it('counts weekdays from the start date', () => {
    // 2026-10-22 is a Thursday.
    expect(dueFromEstimate('2026-10-22', 1)).toBe('2026-10-22')
    expect(dueFromEstimate('2026-10-22', 0.5)).toBe('2026-10-22')
    expect(dueFromEstimate('2026-10-22', 2)).toBe('2026-10-23')
    expect(dueFromEstimate('2026-10-22', 3)).toBe('2026-10-26')
    expect(dueFromEstimate('2026-10-22', 2.5)).toBe('2026-10-26')
    expect(dueFromEstimate('2026-10-22', 10)).toBe('2026-11-04')
    // Work started on a weekend begins on Monday.
    expect(dueFromEstimate('2026-10-24', 1)).toBe('2026-10-26')
    expect(dueFromEstimate('2026-12-31', 2)).toBe('2027-01-01')
  })

  it('knows in-progress columns by their title', () => {
    for (const title of ['In progress', 'in-progress', 'Doing', 'WIP', 'Ongoing']) expect(isInProgressColumn(title)).toBe(true)
    for (const title of ['To do', 'Backlog', 'Review', 'Done']) expect(isInProgressColumn(title)).toBe(false)
  })

  it('starts other cards when they move into progress', () => {
    const card = { startDate: null, dueDate: null, estimateDays: 3 }
    expect(startWorkPatch(card, ['Ticket'], 'In progress', '2026-10-22')).toEqual({
      startDate: '2026-10-22',
      dueDate: '2026-10-26',
    })
    expect(startWorkPatch({ ...card, estimateDays: null }, [], 'Doing', '2026-10-22')).toEqual({
      startDate: '2026-10-22',
    })
    expect(startWorkPatch(card, ['Ticket'], 'Review', '2026-10-22')).toBeNull()
    expect(startWorkPatch({ ...card, startDate: '2026-10-01' }, [], 'In progress', '2026-10-22')).toBeNull()
    expect(startWorkPatch(card, ['R4C'], 'In progress', '2026-10-22')).toBeNull()
  })
})
