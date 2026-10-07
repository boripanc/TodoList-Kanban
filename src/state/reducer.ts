import type { AppState, Board, Card, Column, Label, Role } from '../types'
import { extractBoardDoc, type BoardDoc } from '../cloud/doc'
import { templateColumns, templateLabels, type BoardTemplate } from './templates'

export type Action =
  | { type: 'board/add'; id: string; title: string; template: BoardTemplate; ids: string[]; now: number }
  | { type: 'board/rename'; boardId: string; title: string }
  | { type: 'board/delete'; boardId: string }
  | { type: 'board/select'; boardId: string }
  | { type: 'label/add'; boardId: string; label: Label }
  | { type: 'label/update'; boardId: string; labelId: string; patch: Partial<Omit<Label, 'id'>> }
  | { type: 'label/delete'; boardId: string; labelId: string }
  | { type: 'column/add'; boardId: string; id: string; title: string }
  | { type: 'column/update'; columnId: string; patch: Partial<Pick<Column, 'title' | 'wipLimit'>> }
  | { type: 'column/delete'; boardId: string; columnId: string }
  | { type: 'column/move'; boardId: string; columnId: string; toIndex: number }
  | { type: 'column/clear'; columnId: string }
  | { type: 'card/add'; columnId: string; id: string; title: string; now: number }
  | { type: 'card/update'; cardId: string; patch: Partial<Omit<Card, 'id' | 'createdAt'>>; now: number }
  | { type: 'card/delete'; cardId: string }
  | { type: 'card/duplicate'; cardId: string; newId: string; now: number }
  | { type: 'card/move'; cardId: string; toColumnId: string; toIndex: number }
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
  version: 2,
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
    case 'column/add':
    case 'column/delete':
    case 'column/move':
      return action.boardId
    case 'column/update':
    case 'column/clear':
    case 'card/add':
      return Object.values(state.boards).find((b) => b.columnIds.includes(action.columnId))?.id
    case 'card/update':
    case 'card/delete':
    case 'card/duplicate':
    case 'card/move':
    case 'card/logProgress':
    case 'card/deleteProgress': {
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
        priority: 'none',
        dueDate: null,
        checklist: [],
        progress: null,
        progressLog: [],
        createdAt: action.now,
        updatedAt: action.now,
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
        checklist: card.checklist.map((item, i) => ({ ...item, id: `${action.newId}-${i}` })),
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
