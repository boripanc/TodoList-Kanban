import type { AppState, Board, Card, Column, AdapterType, InterfaceSpec, Label, Role, TeamMember } from '../types'
import { extractBoardDoc, type BoardDoc } from '../cloud/doc'
import { templateColumns, templateLabels, type BoardTemplate } from './templates'
import { MAX_ESTIMATE_DAYS, startWorkPatch } from '../lib/schedule'
import { applySpecPatch, emptySpec } from '../lib/interfaces'

/** What the new-card dialog can fill in besides the title. */
export type NewCardDetails = Partial<
  Pick<Card, 'description' | 'labelIds' | 'assigneeIds' | 'priority' | 'startDate' | 'dueDate' | 'estimateDays' | 'spec'>
>

export type Action =
  | { type: 'board/add'; id: string; title: string; template: BoardTemplate; ids: string[]; now: number }
  | { type: 'board/rename'; boardId: string; title: string }
  | { type: 'board/delete'; boardId: string }
  | { type: 'board/select'; boardId: string }
  | { type: 'label/add'; boardId: string; label: Label }
  | { type: 'label/update'; boardId: string; labelId: string; patch: Partial<Omit<Label, 'id'>> }
  | { type: 'label/delete'; boardId: string; labelId: string }
  | { type: 'team/add'; boardId: string; member: TeamMember }
  | { type: 'team/update'; boardId: string; memberId: string; patch: Partial<Omit<TeamMember, 'id'>> }
  /** Remove someone from the team and from every card they were assigned to. */
  | { type: 'team/delete'; boardId: string; memberId: string }
  /** Assign a card to a team member, or take them off it. */
  | { type: 'card/toggleAssignee'; cardId: string; memberId: string; now: number }
  | { type: 'column/add'; boardId: string; id: string; title: string }
  | { type: 'column/update'; columnId: string; patch: Partial<Pick<Column, 'title' | 'wipLimit'>> }
  | { type: 'column/delete'; boardId: string; columnId: string }
  | { type: 'column/move'; boardId: string; columnId: string; toIndex: number }
  | { type: 'column/clear'; columnId: string }
  /** Add a card at the bottom of a column, optionally filled in from the new-card dialog. */
  | { type: 'card/add'; columnId: string; id: string; title: string; now: number; details?: NewCardDetails }
  | { type: 'card/update'; cardId: string; patch: Partial<Omit<Card, 'id' | 'createdAt'>>; now: number }
  /**
   * Change part of a card's interface spec, giving the card one if it has
   * none; `patch: null` takes the spec off (the card stays).
   */
  | { type: 'card/updateSpec'; cardId: string; patch: Partial<InterfaceSpec> | null; now: number }
  /** Add an interface to build: a card with an empty spec, optionally assigned to a team member. */
  | {
      type: 'card/addInterface'
      columnId: string
      id: string
      title: string
      senderAdapter: AdapterType
      receiverAdapter: AdapterType
      memberId: string | null
      now: number
    }
  | { type: 'card/delete'; cardId: string }
  | { type: 'card/duplicate'; cardId: string; newId: string; now: number }
  | { type: 'card/move'; cardId: string; toColumnId: string; toIndex: number }
  /**
   * After a move: if the card now sits in an in-progress column and hasn't
   * started, it starts `today` and its due date follows from its estimate.
   * R4C and Project cards keep the dates set by hand.
   */
  | { type: 'card/startWork'; cardId: string; today: string; now: number }
  /** Add a progress update; a given `progress` also becomes the card's progress. */
  | { type: 'card/logProgress'; cardId: string; id: string; text: string; progress: number | null; now: number }
  | { type: 'card/deleteProgress'; cardId: string; entryId: string; now: number }
  | { type: 'state/replace'; state: AppState }
  /** Put a board fetched from the cloud in place of the local copy, or add it. */
  | { type: 'board/load'; doc: BoardDoc; role: Role }
  /** Drop a cloud board from this device (left, removed, or deleted elsewhere). */
  | { type: 'board/unload'; boardId: string }
  /** Mark a board as living in the account (`role`) or on this device only (null). */
  | { type: 'board/setCloud'; boardId: string; role: Role | null }
  /** Drop every cloud board, e.g. on sign-out. */
  | { type: 'cloud/clear' }

export const initialState: AppState = {
  version: 7,
  boardOrder: [],
  activeBoardId: null,
  boards: {},
  columns: {},
  cards: {},
}

function omit<T>(record: Record<string, T>, keys: string[]): Record<string, T> {
  const next = { ...record }
  for (const key of keys) delete next[key]
  return next
}

function insertAt<T>(list: T[], index: number, item: T): T[] {
  const clamped = Math.max(0, Math.min(index, list.length))
  return [...list.slice(0, clamped), item, ...list.slice(clamped)]
}

export function findColumnOfCard(state: AppState, cardId: string): Column | undefined {
  return Object.values(state.columns).find((column) => column.cardIds.includes(cardId))
}

function removeBoard(state: AppState, boardId: string): AppState {
  const board = state.boards[boardId]
  if (!board) return state
  const cardIds = board.columnIds.flatMap((id) => state.columns[id]?.cardIds ?? [])
  const boardOrder = state.boardOrder.filter((id) => id !== board.id)
  const activeBoardId = state.activeBoardId === board.id ? (boardOrder[0] ?? null) : state.activeBoardId
  return {
    ...state,
    boardOrder,
    activeBoardId,
    boards: omit(state.boards, [board.id]),
    columns: omit(state.columns, board.columnIds),
    cards: omit(state.cards, cardIds),
  }
}

/** The board an action edits, if it edits one. */
function targetBoardId(state: AppState, action: Action): string | undefined {
  switch (action.type) {
    case 'board/rename':
    case 'label/add':
    case 'label/update':
    case 'label/delete':
    case 'team/add':
    case 'team/update':
    case 'team/delete':
    case 'column/add':
    case 'column/delete':
    case 'column/move':
      return action.boardId
    case 'column/update':
    case 'column/clear':
    case 'card/add':
    case 'card/addInterface':
      return Object.values(state.boards).find((b) => b.columnIds.includes(action.columnId))?.id
    case 'card/update':
    case 'card/updateSpec':
    case 'card/delete':
    case 'card/duplicate':
    case 'card/move':
    case 'card/startWork':
    case 'card/logProgress':
    case 'card/deleteProgress':
    case 'card/toggleAssignee': {
      const column = findColumnOfCard(state, action.cardId)
      return column && Object.values(state.boards).find((b) => b.columnIds.includes(column.id))?.id
    }
    default:
      return undefined
  }
}

/** A whole percentage from 0 to 100, or null when not tracked. */
export function clampProgress(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return Math.min(100, Math.max(0, Math.round(value)))
}

/** A whole number of open cards, 0 meaning no limit. */
export function clampCapacity(value: number): number {
  return Number.isFinite(value) ? Math.min(999, Math.max(0, Math.floor(value))) : 0
}

/** The board a card is on. */
export function findBoardOfCard(state: AppState, cardId: string): Board | undefined {
  const column = findColumnOfCard(state, cardId)
  return column && Object.values(state.boards).find((b) => b.columnIds.includes(column.id))
}

export function isReadOnly(board: Board | undefined): boolean {
  return board?.cloud?.role === 'viewer'
}

export function reducer(state: AppState, action: Action): AppState {
  // Viewers of a shared board can look but not change anything.
  const target = targetBoardId(state, action)
  if (target && isReadOnly(state.boards[target])) return state

  switch (action.type) {
    case 'board/add': {
      // `ids` supplies pre-generated ids: first for columns, then for labels.
      const columnTitles = templateColumns[action.template]
      const labelSeeds = templateLabels[action.template]
      const columnIds = action.ids.slice(0, columnTitles.length)
      const labelIds = action.ids.slice(columnTitles.length, columnTitles.length + labelSeeds.length)
      const columns: Record<string, Column> = { ...state.columns }
      columnTitles.forEach((title, i) => {
        columns[columnIds[i]] = { id: columnIds[i], title, cardIds: [], wipLimit: 0 }
      })
      const board: Board = {
        id: action.id,
        title: action.title.trim() || 'Untitled board',
        columnIds,
        labels: labelSeeds.map((seed, i) => ({ ...seed, id: labelIds[i] })),
        team: [],
        createdAt: action.now,
      }
      return {
        ...state,
        boards: { ...state.boards, [board.id]: board },
        boardOrder: [...state.boardOrder, board.id],
        columns,
        activeBoardId: board.id,
      }
    }

    case 'board/rename': {
      const board = state.boards[action.boardId]
      const title = action.title.trim()
      if (!board || !title) return state
      return { ...state, boards: { ...state.boards, [board.id]: { ...board, title } } }
    }

    case 'board/delete':
    case 'board/unload':
      return removeBoard(state, action.boardId)

    case 'board/select':
      if (!state.boards[action.boardId]) return state
      return { ...state, activeBoardId: action.boardId }

    case 'label/add': {
      const board = state.boards[action.boardId]
      if (!board) return state
      return {
        ...state,
        boards: { ...state.boards, [board.id]: { ...board, labels: [...board.labels, action.label] } },
      }
    }

    case 'label/update': {
      const board = state.boards[action.boardId]
      if (!board) return state
      const labels = board.labels.map((label) =>
        label.id === action.labelId ? { ...label, ...action.patch } : label,
      )
      return { ...state, boards: { ...state.boards, [board.id]: { ...board, labels } } }
    }

    case 'label/delete': {
      const board = state.boards[action.boardId]
      if (!board) return state
      const cards = { ...state.cards }
      for (const columnId of board.columnIds) {
        for (const cardId of state.columns[columnId]?.cardIds ?? []) {
          const card = cards[cardId]
          if (card?.labelIds.includes(action.labelId)) {
            cards[cardId] = { ...card, labelIds: card.labelIds.filter((id) => id !== action.labelId) }
          }
        }
      }
      const labels = board.labels.filter((label) => label.id !== action.labelId)
      return { ...state, cards, boards: { ...state.boards, [board.id]: { ...board, labels } } }
    }

    case 'team/add': {
      const board = state.boards[action.boardId]
      const name = action.member.name.trim()
      if (!board || !name || board.team.some((m) => m.id === action.member.id)) return state
      const member = { ...action.member, name, capacity: clampCapacity(action.member.capacity) }
      return { ...state, boards: { ...state.boards, [board.id]: { ...board, team: [...board.team, member] } } }
    }

    case 'team/update': {
      const board = state.boards[action.boardId]
      if (!board) return state
      const patch = { ...action.patch }
      if (patch.name !== undefined) {
        patch.name = patch.name.trim()
        if (!patch.name) delete patch.name
      }
      if (patch.capacity !== undefined) patch.capacity = clampCapacity(patch.capacity)
      const team = board.team.map((m) => (m.id === action.memberId ? { ...m, ...patch } : m))
      return { ...state, boards: { ...state.boards, [board.id]: { ...board, team } } }
    }

    case 'team/delete': {
      const board = state.boards[action.boardId]
      if (!board) return state
      const cards = { ...state.cards }
      for (const columnId of board.columnIds) {
        for (const cardId of state.columns[columnId]?.cardIds ?? []) {
          const card = cards[cardId]
          if (card?.assigneeIds.includes(action.memberId)) {
            cards[cardId] = { ...card, assigneeIds: card.assigneeIds.filter((id) => id !== action.memberId) }
          }
        }
      }
      const team = board.team.filter((m) => m.id !== action.memberId)
      return { ...state, cards, boards: { ...state.boards, [board.id]: { ...board, team } } }
    }

    case 'card/toggleAssignee': {
      const card = state.cards[action.cardId]
      const board = findBoardOfCard(state, action.cardId)
      if (!card || !board) return state
      const assigned = card.assigneeIds.includes(action.memberId)
      // Only people on the board's team can be assigned.
      if (!assigned && !board.team.some((m) => m.id === action.memberId)) return state
      const assigneeIds = assigned
        ? card.assigneeIds.filter((id) => id !== action.memberId)
        : [...card.assigneeIds, action.memberId]
      return { ...state, cards: { ...state.cards, [card.id]: { ...card, assigneeIds, updatedAt: action.now } } }
    }

    case 'column/add': {
      const board = state.boards[action.boardId]
      if (!board) return state
      const column: Column = {
        id: action.id,
        title: action.title.trim() || 'Untitled',
        cardIds: [],
        wipLimit: 0,
      }
      return {
        ...state,
        columns: { ...state.columns, [column.id]: column },
        boards: {
          ...state.boards,
          [board.id]: { ...board, columnIds: [...board.columnIds, column.id] },
        },
      }
    }

    case 'column/update': {
      const column = state.columns[action.columnId]
      if (!column) return state
      const patch = { ...action.patch }
      if (patch.title !== undefined) {
        patch.title = patch.title.trim()
        if (!patch.title) delete patch.title
      }
      if (patch.wipLimit !== undefined) {
        patch.wipLimit = Math.max(0, Math.floor(patch.wipLimit) || 0)
      }
      return { ...state, columns: { ...state.columns, [column.id]: { ...column, ...patch } } }
    }

    case 'column/delete': {
      const board = state.boards[action.boardId]
      const column = state.columns[action.columnId]
      if (!board || !column) return state
      return {
        ...state,
        boards: {
          ...state.boards,
          [board.id]: { ...board, columnIds: board.columnIds.filter((id) => id !== column.id) },
        },
        columns: omit(state.columns, [column.id]),
        cards: omit(state.cards, column.cardIds),
      }
    }

    case 'column/move': {
      const board = state.boards[action.boardId]
      if (!board || !board.columnIds.includes(action.columnId)) return state
      const rest = board.columnIds.filter((id) => id !== action.columnId)
      const columnIds = insertAt(rest, action.toIndex, action.columnId)
      return { ...state, boards: { ...state.boards, [board.id]: { ...board, columnIds } } }
    }

    case 'column/clear': {
      const column = state.columns[action.columnId]
      if (!column) return state
      return {
        ...state,
        columns: { ...state.columns, [column.id]: { ...column, cardIds: [] } },
        cards: omit(state.cards, column.cardIds),
      }
    }

    case 'card/add': {
      const column = state.columns[action.columnId]
      const title = action.title.trim()
      if (!column || !title) return state
      const card: Card = {
        id: action.id,
        title,
        description: '',
        labelIds: [],
        assigneeIds: [],
        priority: 'none',
        startDate: null,
        dueDate: null,
        estimateDays: null,
        checklist: [],
        progress: null,
        progressLog: [],
        spec: null,
        createdAt: action.now,
        updatedAt: action.now,
      }
      const details = action.details
      if (details) {
        const board = Object.values(state.boards).find((b) => b.columnIds.includes(column.id))
        if (details.description) card.description = details.description
        if (details.priority) card.priority = details.priority
        // Only the board's own labels and team members can be put on a card.
        if (details.labelIds) card.labelIds = details.labelIds.filter((id) => board?.labels.some((l) => l.id === id))
        if (details.assigneeIds) {
          card.assigneeIds = [...new Set(details.assigneeIds)].filter((id) => board?.team.some((m) => m.id === id))
        }
        if (details.startDate) card.startDate = details.startDate
        if (details.dueDate) card.dueDate = details.dueDate
        if (details.estimateDays && details.estimateDays > 0) card.estimateDays = Math.min(details.estimateDays, MAX_ESTIMATE_DAYS)
        if (details.spec) card.spec = { ...details.spec }
      }
      return {
        ...state,
        cards: { ...state.cards, [card.id]: card },
        columns: {
          ...state.columns,
          [column.id]: { ...column, cardIds: [...column.cardIds, card.id] },
        },
      }
    }

    case 'card/addInterface': {
      const board = Object.values(state.boards).find((b) => b.columnIds.includes(action.columnId))
      if (!board || state.cards[action.id]) return state
      const added = reducer(state, { type: 'card/add', columnId: action.columnId, id: action.id, title: action.title, now: action.now })
      const card = added.cards[action.id]
      if (!card) return state
      const onTeam = action.memberId !== null && board.team.some((m) => m.id === action.memberId)
      const next: Card = { ...card, spec: emptySpec(action.senderAdapter, action.receiverAdapter), assigneeIds: onTeam ? [action.memberId!] : [] }
      return { ...added, cards: { ...added.cards, [card.id]: next } }
    }

    case 'card/updateSpec': {
      const card = state.cards[action.cardId]
      if (!card) return state
      if (action.patch === null && card.spec === null) return state
      const spec = applySpecPatch(card.spec, action.patch)
      return { ...state, cards: { ...state.cards, [card.id]: { ...card, spec, updatedAt: action.now } } }
    }

    case 'card/update': {
      const card = state.cards[action.cardId]
      if (!card) return state
      const patch = { ...action.patch }
      if (patch.title !== undefined) {
        patch.title = patch.title.trim()
        if (!patch.title) delete patch.title
      }
      if (patch.progress !== undefined) patch.progress = clampProgress(patch.progress)
      return {
        ...state,
        cards: { ...state.cards, [card.id]: { ...card, ...patch, updatedAt: action.now } },
      }
    }

    case 'card/delete': {
      const column = findColumnOfCard(state, action.cardId)
      const columns = column
        ? {
            ...state.columns,
            [column.id]: { ...column, cardIds: column.cardIds.filter((id) => id !== action.cardId) },
          }
        : state.columns
      return { ...state, columns, cards: omit(state.cards, [action.cardId]) }
    }

    case 'card/duplicate': {
      const card = state.cards[action.cardId]
      const column = findColumnOfCard(state, action.cardId)
      if (!card || !column) return state
      const copy: Card = {
        ...card,
        id: action.newId,
        title: `${card.title} (copy)`,
        labelIds: [...card.labelIds],
        assigneeIds: [...card.assigneeIds],
        checklist: card.checklist.map((item, i) => ({ ...item, id: `${action.newId}-${i}` })),
        spec: card.spec && { ...card.spec },
        // The copy is a new task: it starts without progress history.
        progress: null,
        progressLog: [],
        createdAt: action.now,
        updatedAt: action.now,
      }
      const index = column.cardIds.indexOf(card.id) + 1
      return {
        ...state,
        cards: { ...state.cards, [copy.id]: copy },
        columns: {
          ...state.columns,
          [column.id]: { ...column, cardIds: insertAt(column.cardIds, index, copy.id) },
        },
      }
    }

    case 'card/logProgress': {
      const card = state.cards[action.cardId]
      const text = action.text.trim()
      const progress = clampProgress(action.progress)
      if (!card || (!text && progress === null)) return state
      const entry = { id: action.id, text, progress, at: action.now }
      const next: Card = {
        ...card,
        progress: progress ?? card.progress,
        progressLog: [...card.progressLog, entry],
        updatedAt: action.now,
      }
      return { ...state, cards: { ...state.cards, [card.id]: next } }
    }

    case 'card/deleteProgress': {
      const card = state.cards[action.cardId]
      if (!card || !card.progressLog.some((e) => e.id === action.entryId)) return state
      const next: Card = {
        ...card,
        progressLog: card.progressLog.filter((e) => e.id !== action.entryId),
        updatedAt: action.now,
      }
      return { ...state, cards: { ...state.cards, [card.id]: next } }
    }

    case 'card/move': {
      const from = findColumnOfCard(state, action.cardId)
      const to = state.columns[action.toColumnId]
      if (!from || !to) return state
      if (from.id === to.id) {
        const current = from.cardIds.indexOf(action.cardId)
        if (current === action.toIndex) return state
        const rest = from.cardIds.filter((id) => id !== action.cardId)
        return {
          ...state,
          columns: {
            ...state.columns,
            [from.id]: { ...from, cardIds: insertAt(rest, action.toIndex, action.cardId) },
          },
        }
      }
      return {
        ...state,
        columns: {
          ...state.columns,
          [from.id]: { ...from, cardIds: from.cardIds.filter((id) => id !== action.cardId) },
          [to.id]: { ...to, cardIds: insertAt(to.cardIds, action.toIndex, action.cardId) },
        },
      }
    }

    case 'card/startWork': {
      const card = state.cards[action.cardId]
      const column = findColumnOfCard(state, action.cardId)
      const board = column && Object.values(state.boards).find((b) => b.columnIds.includes(column.id))
      if (!card || !column || !board) return state
      const labelNames = board.labels.filter((l) => card.labelIds.includes(l.id)).map((l) => l.name)
      const patch = startWorkPatch(card, labelNames, column.title, action.today)
      if (!patch) return state
      return { ...state, cards: { ...state.cards, [card.id]: { ...card, ...patch, updatedAt: action.now } } }
    }

    case 'state/replace': {
      // Importing a backup replaces the boards on this device. Account boards
      // stay as they are; boards in the backup come back as device-only copies.
      const cloudIds = state.boardOrder.filter((id) => state.boards[id]?.cloud)
      let next = cloudIds.reduce((acc, id) => removeBoard(acc, id), action.state)
      next = {
        ...next,
        boards: Object.fromEntries(
          Object.entries(next.boards).map(([id, board]) => {
            const { cloud: _cloud, ...rest } = board
            return [id, rest]
          }),
        ),
      }
      for (const id of cloudIds) {
        const doc = extractBoardDoc(state, id)!
        next = reducer(next, { type: 'board/load', doc, role: state.boards[id].cloud!.role })
      }
      return { ...next, activeBoardId: action.state.activeBoardId ?? next.activeBoardId }
    }

    case 'board/load': {
      const { doc } = action
      const existing = state.boards[doc.board.id]
      const base = existing ? removeBoard(state, doc.board.id) : state
      const columns = { ...base.columns }
      for (const column of doc.columns) columns[column.id] = column
      const cards = { ...base.cards }
      for (const card of doc.cards) cards[card.id] = card
      const boardOrder = existing
        ? state.boardOrder
        : [...state.boardOrder.filter((id) => id !== doc.board.id), doc.board.id]
      return {
        ...base,
        boards: { ...base.boards, [doc.board.id]: { ...doc.board, cloud: { role: action.role } } },
        columns,
        cards,
        boardOrder,
        activeBoardId: existing ? state.activeBoardId : (state.activeBoardId ?? doc.board.id),
      }
    }

    case 'board/setCloud': {
      const board = state.boards[action.boardId]
      if (!board) return state
      const { cloud: _cloud, ...rest } = board
      const next: Board = action.role ? { ...rest, cloud: { role: action.role } } : rest
      return { ...state, boards: { ...state.boards, [board.id]: next } }
    }

    case 'cloud/clear':
      return state.boardOrder
        .filter((id) => state.boards[id]?.cloud)
        .reduce((acc, id) => removeBoard(acc, id), state)
  }
}
