import type { AppState } from '../types'
import { createId } from '../lib/id'
import { todayISO } from '../lib/dates'
import { initialState, reducer, type Action } from './reducer'
import { templateColumns, templateLabels, type BoardTemplate } from './templates'

export const STORAGE_KEY = 'todolist-kanban/state'

export function isAppState(value: unknown): value is AppState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    v.version === 1 &&
    Array.isArray(v.boardOrder) &&
    typeof v.boards === 'object' &&
    v.boards !== null &&
    typeof v.columns === 'object' &&
    v.columns !== null &&
    typeof v.cards === 'object' &&
    v.cards !== null
  )
}

export function loadState(storage: Storage | undefined = globalThis.localStorage): AppState {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (isAppState(parsed)) return parsed
    }
  } catch {
    // Unreadable or blocked storage: fall through to sample data.
  }
  return createSampleState()
}

export function saveState(state: AppState, storage: Storage | undefined = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Quota exceeded or storage blocked; the in-memory state still works.
  }
}

/** Build the add-board action, generating ids for the template's columns and labels. */
export function addBoardAction(title: string, template: BoardTemplate, now = Date.now()): Action {
  const count = templateColumns[template].length + templateLabels[template].length
  return {
    type: 'board/add',
    id: createId(),
    title,
    template,
    ids: Array.from({ length: count }, createId),
    now,
  }
}

function addDays(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return todayISO(d)
}

/** First-run content that shows off what the board can do. */
export function createSampleState(): AppState {
  const now = Date.now()
  let state = reducer(initialState, addBoardAction('Work', 'work', now))
  const work = state.boards[state.activeBoardId!]
  const [backlog, todo, doing, review, done] = work.columnIds
  const label = (name: string) => work.labels.find((l) => l.name === name)!.id

  const add = (columnId: string, title: string, patch: Parameters<typeof cardPatch>[0] = {}) => {
    const id = createId()
    state = reducer(state, { type: 'card/add', columnId, id, title, now })
    state = reducer(state, { type: 'card/update', cardId: id, patch: cardPatch(patch), now })
  }

  add(backlog, 'Explore keyboard shortcuts', {
    description: 'Press / to search, N to add a card to the first column.',
    labelIds: [label('Docs')],
  })
  add(todo, 'Plan next sprint', {
    priority: 'high',
    dueDate: addDays(2),
    labelIds: [label('Meeting')],
    checklist: ['Review backlog', 'Estimate stories', 'Agree on goals'],
  })
  add(todo, 'Fix login timeout', { priority: 'urgent', dueDate: addDays(-1), labelIds: [label('Bug')] })
  add(doing, 'Drag me to another column', {
    description: 'Cards and columns can both be reordered by dragging.',
    priority: 'medium',
    labelIds: [label('Feature')],
    dueDate: addDays(0),
  })
  add(review, 'Click a card to edit details', {
    description: 'Add labels, a due date, a priority, a checklist or notes.',
    priority: 'low',
  })
  add(done, 'Set up the board', { checklist: ['Create columns', 'Add labels'], checkedAll: true })
  state = reducer(state, { type: 'column/update', columnId: doing, patch: { wipLimit: 3 } })

  state = reducer(state, addBoardAction('Personal', 'personal', now))
  const personal = state.boards[state.activeBoardId!]
  const plabel = (name: string) => personal.labels.find((l) => l.name === name)!.id
  add(personal.columnIds[0], 'Buy groceries', {
    labelIds: [plabel('Errand')],
    dueDate: addDays(0),
    checklist: ['Milk', 'Eggs', 'Bread'],
  })
  add(personal.columnIds[0], 'Pay electricity bill', {
    labelIds: [plabel('Finance')],
    priority: 'high',
    dueDate: addDays(3),
  })
  add(personal.columnIds[1], 'Morning run', { labelIds: [plabel('Health')] })

  return { ...state, activeBoardId: work.id }
}

function cardPatch(seed: {
  description?: string
  labelIds?: string[]
  priority?: 'none' | 'low' | 'medium' | 'high' | 'urgent'
  dueDate?: string
  checklist?: string[]
  checkedAll?: boolean
}) {
  return {
    description: seed.description ?? '',
    labelIds: seed.labelIds ?? [],
    priority: seed.priority ?? 'none',
    dueDate: seed.dueDate ?? null,
    checklist: (seed.checklist ?? []).map((text) => ({
      id: createId(),
      text,
      done: seed.checkedAll ?? false,
    })),
  }
}
