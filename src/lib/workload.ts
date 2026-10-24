import type { AppState, Card, TeamMember } from '../types'
import { daysUntil } from './dates'
import { isDoneColumn } from './done'

/** What workload needs to know about a card. */
export interface Workable {
  assigneeIds: string[]
  dueDate: string | null
}

export interface WorkItem<C extends Workable> {
  card: C
  /** In a done column, so it no longer counts as work in hand. */
  done: boolean
}

export interface MemberLoad<C extends Workable> {
  /** The member id, or for people merged across boards, their name in lower case. */
  key: string
  name: string
  color: string
  /** Open cards this person can take on; 0 means no limit. */
  capacity: number
  /** The team member ids this row covers (one per board when merged). */
  memberIds: string[]
  /** Assigned cards not yet done, in board order. */
  open: C[]
  doneCount: number
  overdue: number
  /** Open cards due today or in the next 7 days. */
  dueSoon: number
}

export interface Workload<C extends Workable> {
  members: MemberLoad<C>[]
  /** Open cards nobody is assigned to. */
  unassigned: C[]
}

export type LoadLevel = 'free' | 'busy' | 'full' | 'over'

/** How loaded someone is against their capacity. Without a capacity, only whether they have work. */
export function loadLevel(load: { open: unknown[]; capacity: number }): LoadLevel {
  const count = load.open.length
  if (load.capacity <= 0) return count === 0 ? 'free' : 'busy'
  if (count > load.capacity) return 'over'
  if (count === load.capacity) return 'full'
  return count === 0 ? 'free' : 'busy'
}

/** Each team member's open and finished cards, plus open cards nobody has. */
export function computeWorkload<C extends Workable>(
  team: TeamMember[],
  items: WorkItem<C>[],
  now: Date = new Date(),
): Workload<C> {
  const members = team.map<MemberLoad<C>>((m) => ({
    key: m.id,
    name: m.name,
    color: m.color,
    capacity: m.capacity,
    memberIds: [m.id],
    open: [],
    doneCount: 0,
    overdue: 0,
    dueSoon: 0,
  }))
  const byId = new Map(members.map((m) => [m.key, m]))
  const unassigned: C[] = []
  for (const { card, done } of items) {
    const assigned = card.assigneeIds.map((id) => byId.get(id)).filter((m): m is MemberLoad<C> => !!m)
    if (assigned.length === 0) {
      if (!done) unassigned.push(card)
      continue
    }
    const days = card.dueDate ? daysUntil(card.dueDate, now) : null
    for (const member of assigned) {
      if (done) {
        member.doneCount++
        continue
      }
      member.open.push(card)
      if (days !== null && days < 0) member.overdue++
      else if (days !== null && days <= 7) member.dueSoon++
    }
  }
  return { members, unassigned }
}

/**
 * Join several boards' workloads, treating team members with the same name
 * (ignoring case) as one person. Their capacities add up.
 */
export function mergeWorkloads<C extends Workable>(list: Workload<C>[]): Workload<C> {
  const merged = new Map<string, MemberLoad<C>>()
  for (const workload of list) {
    for (const m of workload.members) {
      const key = m.name.trim().toLowerCase()
      const row = merged.get(key)
      if (!row) {
        merged.set(key, { ...m, key, memberIds: [...m.memberIds], open: [...m.open] })
        continue
      }
      row.capacity += m.capacity
      row.memberIds.push(...m.memberIds)
      row.open.push(...m.open)
      row.doneCount += m.doneCount
      row.overdue += m.overdue
      row.dueSoon += m.dueSoon
    }
  }
  return {
    members: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)),
    unassigned: list.flatMap((w) => w.unassigned),
  }
}

/** The cards of a board in column order, each marked done or not. */
export function boardWorkItems(state: AppState, boardId: string): WorkItem<Card>[] {
  const board = state.boards[boardId]
  if (!board) return []
  return board.columnIds.flatMap((columnId) => {
    const column = state.columns[columnId]
    if (!column) return []
    const done = isDoneColumn(column.title)
    return column.cardIds.flatMap((id) => (state.cards[id] ? [{ card: state.cards[id], done }] : []))
  })
}

export function boardWorkload(state: AppState, boardId: string, now: Date = new Date()): Workload<Card> {
  return computeWorkload(state.boards[boardId]?.team ?? [], boardWorkItems(state, boardId), now)
}

/** Initials for an avatar: the first letters of the first two words. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const letters = words.length === 1 ? [...words[0]].slice(0, 2) : [[...words[0]][0], [...words[1]][0]]
  return letters.join('').toUpperCase()
}
