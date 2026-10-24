import { describe, expect, it } from 'vitest'
import type { TeamMember } from '../types'
import { computeWorkload, initials, loadLevel, mergeWorkloads, type Workable } from './workload'

const now = new Date(2026, 9, 6, 12) // 6 Oct 2026
const team: TeamMember[] = [
  { id: 'ana', name: 'Ana', color: '#0090ff', capacity: 2 },
  { id: 'ben', name: 'Ben', color: '#d6409f', capacity: 0 },
]
const card = (title: string, assigneeIds: string[], dueDate: string | null = null) => ({ title, assigneeIds, dueDate })

describe('workload', () => {
  it('counts open, done, overdue and soon-due cards per person, and open cards nobody has', () => {
    const { members, unassigned } = computeWorkload(
      team,
      [
        { card: card('Late', ['ana'], '2026-10-01'), done: false },
        { card: card('Soon', ['ana', 'ben'], '2026-10-10'), done: false },
        { card: card('Later', ['ben'], '2026-12-01'), done: false },
        { card: card('Shipped', ['ana'], '2026-10-01'), done: true },
        { card: card('Nobody', []), done: false },
        { card: card('Nobody, done', []), done: true },
        { card: card('Gone', ['someone-removed']), done: false },
      ],
      now,
    )
    const [ana, ben] = members
    expect(ana.open.map((c) => c.title)).toEqual(['Late', 'Soon'])
    expect([ana.doneCount, ana.overdue, ana.dueSoon]).toEqual([1, 1, 1])
    expect(ben.open.map((c) => c.title)).toEqual(['Soon', 'Later'])
    expect([ben.doneCount, ben.overdue, ben.dueSoon]).toEqual([0, 0, 1])
    expect(unassigned.map((c) => c.title)).toEqual(['Nobody', 'Gone'])
  })

  it('rates load against capacity', () => {
    expect(loadLevel({ open: [], capacity: 2 })).toBe('free')
    expect(loadLevel({ open: [1], capacity: 2 })).toBe('busy')
    expect(loadLevel({ open: [1, 2], capacity: 2 })).toBe('full')
    expect(loadLevel({ open: [1, 2, 3], capacity: 2 })).toBe('over')
    expect(loadLevel({ open: [1, 2, 3], capacity: 0 })).toBe('busy')
    expect(loadLevel({ open: [], capacity: 0 })).toBe('free')
  })

  it('joins people with the same name across boards', () => {
    const other: TeamMember[] = [
      { id: 'x', name: 'ana ', color: '#000000', capacity: 1 },
      { id: 'y', name: 'Cleo', color: '#000000', capacity: 0 },
    ]
    const a = computeWorkload<Workable>(team, [{ card: card('A', ['ana']), done: false }], now)
    const b = computeWorkload<Workable>(other, [{ card: card('B', ['x']), done: false }, { card: card('C', []), done: false }], now)
    const merged = mergeWorkloads([a, b])
    expect(merged.members.map((m) => m.name)).toEqual(['Ana', 'Ben', 'Cleo'])
    expect(merged.members[0]).toMatchObject({ capacity: 3, memberIds: ['ana', 'x'] })
    expect(merged.members[0].open).toHaveLength(2)
    expect(merged.unassigned).toHaveLength(1)
  })

  it('makes avatar initials', () => {
    expect(initials('Ana Lee Park')).toBe('AL')
    expect(initials('ben')).toBe('BE')
    expect(initials('  ')).toBe('?')
  })
})
