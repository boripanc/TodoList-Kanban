import { describe, expect, it } from 'vitest'
import { formatSchedule, needsDateRange, scheduleProblem } from './schedule'

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
