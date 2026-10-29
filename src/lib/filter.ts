import type { Card, CardFilter } from '../types'
import { daysUntil } from './dates'

/** The assignee filter value for cards nobody is assigned to. */
export const UNASSIGNED = '__unassigned'

export const emptyFilter: CardFilter = {
  query: '',
  labelIds: [],
  priorities: [],
  assigneeIds: [],
  due: 'any',
}

export function isFilterActive(filter: CardFilter): boolean {
  return (
    filter.query.trim() !== '' ||
    filter.labelIds.length > 0 ||
    filter.priorities.length > 0 ||
    filter.assigneeIds.length > 0 ||
    filter.due !== 'any'
  )
}

export function matchesFilter(card: Card, filter: CardFilter, now: Date = new Date()): boolean {
  const query = filter.query.trim().toLowerCase()
  if (query) {
    const haystack = [card.title, card.description, card.r4cNo, card.ddNo, ...card.checklist.map((i) => i.text), ...card.progressLog.map((e) => e.text)]
      .join('\n')
      .toLowerCase()
    if (!haystack.includes(query)) return false
  }

  if (filter.labelIds.length > 0 && !filter.labelIds.some((id) => card.labelIds.includes(id))) {
    return false
  }

  if (filter.priorities.length > 0 && !filter.priorities.includes(card.priority)) {
    return false
  }

  if (filter.assigneeIds.length > 0) {
    const unassigned = card.assigneeIds.length === 0
    const match =
      (unassigned && filter.assigneeIds.includes(UNASSIGNED)) ||
      card.assigneeIds.some((id) => filter.assigneeIds.includes(id))
    if (!match) return false
  }

  switch (filter.due) {
    case 'any':
      return true
    case 'none':
      return card.dueDate === null
    case 'overdue':
      return card.dueDate !== null && daysUntil(card.dueDate, now) < 0
    case 'today':
      return card.dueDate !== null && daysUntil(card.dueDate, now) === 0
    case 'week': {
      if (card.dueDate === null) return false
      const days = daysUntil(card.dueDate, now)
      return days >= 0 && days <= 7
    }
  }
}
