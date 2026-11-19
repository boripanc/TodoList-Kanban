import type { AppState, Board, TeamMember } from '../types'
import { createId } from '../lib/id'
import { todayISO } from '../lib/dates'
import { withoutMessageFields } from '../lib/interfaces'
import { mergeMembers, remapIds } from '../lib/teams'
import { initialState, reducer, type Action } from './reducer'
import { templateColumns, templateLabels, type BoardTemplate } from './templates'

export const STORAGE_KEY = 'todolist-kanban/state'

/** True for saved state from any version this app can read (see `migrateState`). */
export function isAppState(value: unknown): value is AppState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.version === 'number' &&
    Number.isInteger(v.version) &&
    v.version >= 1 &&
    v.version <= 9 &&
    Array.isArray(v.boardOrder) &&
    typeof v.boards === 'object' &&
    v.boards !== null &&
    typeof v.columns === 'object' &&
    v.columns !== null &&
    typeof v.cards === 'object' &&
    v.cards !== null
  )
}

/**
 * Bring saved state up to the current version. Version 1 cards had no
 * progress; boards before version 3 had no team and cards no assignees;
 * cards before version 4 had no start date, and before version 5 no estimate,
 * and before version 6 no interface spec. Specs before version 7 had source
 * and target message fields, whose text now lives in the notes. Before
 * version 9 each board had its own team; the teams of boards on this device
 * become one team ("My team", people with the same name joined), and account
 * boards get theirs from the server.
 */
export function migrateState(state: AppState): AppState {
  const cards: AppState['cards'] = {}
  for (const [id, card] of Object.entries(state.cards)) {
    cards[id] = {
      ...card,
      assigneeIds: card.assigneeIds ?? [],
      startDate: card.startDate ?? null,
      estimateDays: card.estimateDays ?? null,
      progress: card.progress ?? null,
      progressLog: card.progressLog ?? [],
      spec: card.spec ? withoutMessageFields(card.spec) : null,
    }
  }
  if (state.teams) return { ...state, version: 9, cards }

  // Version 8 and older: a team on each board.
  type OldBoard = Board & { team?: TeamMember[] }
  const boards: AppState['boards'] = {}
  const local = state.boardOrder.filter((id) => {
    const board = state.boards[id] as OldBoard | undefined
    return board && !board.cloud && (board.team?.length ?? 0) > 0
  })
  const merged = mergeMembers(local.map((id) => (state.boards[id] as OldBoard).team ?? []))
  const teams: AppState['teams'] = {}
  const teamId = 'my-team'
  if (local.length > 0) {
    const createdAt = Math.min(...local.map((id) => state.boards[id].createdAt))
    teams[teamId] = { id: teamId, name: 'My team', members: merged.members, createdAt }
  }
  for (const [id, old] of Object.entries(state.boards)) {
    const { team: _team, ...board } = old as OldBoard
    const index = local.indexOf(id)
    boards[id] = { ...board, teamId: index >= 0 ? teamId : null }
    if (index < 0) continue
    for (const columnId of board.columnIds) {
      for (const cardId of state.columns[columnId]?.cardIds ?? []) {
        const card = cards[cardId]
        if (card?.assigneeIds.length) cards[cardId] = { ...card, assigneeIds: remapIds(card.assigneeIds, merged.maps[index]) }
      }
    }
  }
  return { ...state, version: 9, boards, teams, cards }
}

export function loadState(storage: Storage | undefined = globalThis.localStorage): AppState {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (isAppState(parsed)) return migrateState(parsed)
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
export function addBoardAction(
  title: string,
  template: BoardTemplate,
  now = Date.now(),
): Extract<Action, { type: 'board/add' }> {
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
  const alex = createId()
  const sam = createId()
  const team = createId()
  state = reducer(state, { type: 'team/create', id: team, name: 'My team', cloud: false, boardId: work.id, now })
  state = reducer(state, { type: 'member/add', teamId: team, member: { id: alex, name: 'Alex', color: '#0090ff', capacity: 3 } })
  state = reducer(state, { type: 'member/add', teamId: team, member: { id: sam, name: 'Sam', color: '#d6409f', capacity: 0 } })

  const add = (columnId: string, title: string, patch: Parameters<typeof cardPatch>[0] = {}) => {
    const id = createId()
    state = reducer(state, { type: 'card/add', columnId, id, title, now })
    state = reducer(state, { type: 'card/update', cardId: id, patch: cardPatch(patch), now })
    return id
  }

  add(backlog, 'Explore keyboard shortcuts', {
    description: 'Press / to search, N to add a card to the first column.',
    labelIds: [label('Docs')],
  })
  add(todo, 'Plan next sprint', {
    priority: 'high',
    startDate: addDays(-1),
    dueDate: addDays(2),
    labelIds: [label('Meeting')],
    checklist: ['Review backlog', 'Estimate stories', 'Agree on goals'],
    assigneeIds: [alex, sam],
  })
  add(todo, 'Fix login timeout', {
    priority: 'urgent',
    dueDate: addDays(-1),
    labelIds: [label('Bug')],
    assigneeIds: [alex],
  })
  const dragCard = add(doing, 'Drag me to another column', {
    description: 'Cards and columns can both be reordered by dragging.',
    priority: 'medium',
    labelIds: [label('Feature')],
    dueDate: addDays(0),
    progress: 40,
    assigneeIds: [alex],
  })
  for (const [text, progress, ago] of [
    ['Tried dragging between columns', 20, 2],
    ['Reordered the columns too', 40, 1],
  ] as const) {
    const at = now - ago * 86_400_000
    state = reducer(state, { type: 'card/logProgress', cardId: dragCard, id: createId(), text, progress, now: at })
  }
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
  assigneeIds?: string[]
  priority?: 'none' | 'low' | 'medium' | 'high' | 'urgent'
  startDate?: string
  dueDate?: string
  estimateDays?: number
  checklist?: string[]
  checkedAll?: boolean
  progress?: number
}) {
  return {
    description: seed.description ?? '',
    labelIds: seed.labelIds ?? [],
    assigneeIds: seed.assigneeIds ?? [],
    priority: seed.priority ?? 'none',
    startDate: seed.startDate ?? null,
    dueDate: seed.dueDate ?? null,
    estimateDays: seed.estimateDays ?? null,
    progress: seed.progress ?? null,
    checklist: (seed.checklist ?? []).map((text) => ({
      id: createId(),
      text,
      done: seed.checkedAll ?? false,
    })),
  }
}
