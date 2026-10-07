import type { AppState, Board, Card, Column, Label, Priority, Role } from '../types'

/** One board with its columns and cards, as stored in the cloud. */
export interface BoardDoc {
  board: Omit<Board, 'cloud'>
  columns: Column[]
  cards: Card[]
}

export interface BoardRow {
  id: string
  title: string
  labels: Label[]
  created_at: number
}

export interface ColumnRow {
  id: string
  board_id: string
  position: number
  title: string
  wip_limit: number
}

export interface CardRow {
  id: string
  board_id: string
  column_id: string
  position: number
  title: string
  description: string
  label_ids: string[]
  priority: Priority
  due_date: string | null
  checklist: Card['checklist']
  /** Left out by apps from before progress existed; the server then keeps what it has. */
  progress?: Card['progress']
  progress_log?: Card['progressLog']
  created_at: number
  updated_at: number
}

/** The writes that turn one version of a board into another. */
export interface BoardOps {
  board?: Pick<BoardRow, 'title' | 'labels'>
  upsertColumns: ColumnRow[]
  deleteColumnIds: string[]
  upsertCards: CardRow[]
  deleteCardIds: string[]
}

export function extractBoardDoc(state: AppState, boardId: string): BoardDoc | undefined {
  const board = state.boards[boardId]
  if (!board) return undefined
  const columns = board.columnIds.map((id) => state.columns[id]).filter((c): c is Column => !!c)
  const cards = columns.flatMap((column) => column.cardIds.map((id) => state.cards[id]).filter((c): c is Card => !!c))
  const { cloud: _cloud, ...rest } = board
  return { board: rest, columns, cards }
}

export function boardRow(doc: BoardDoc): BoardRow {
  return { id: doc.board.id, title: doc.board.title, labels: doc.board.labels, created_at: doc.board.createdAt }
}

export function columnRows(doc: BoardDoc): ColumnRow[] {
  return doc.columns.map((column, position) => ({
    id: column.id,
    board_id: doc.board.id,
    position,
    title: column.title,
    wip_limit: column.wipLimit,
  }))
}

export function cardRows(doc: BoardDoc): CardRow[] {
  const cards = new Map(doc.cards.map((card) => [card.id, card]))
  return doc.columns.flatMap((column) =>
    column.cardIds.flatMap((id, position) => {
      const card = cards.get(id)
      if (!card) return []
      return [
        {
          id: card.id,
          board_id: doc.board.id,
          column_id: column.id,
          position,
          title: card.title,
          description: card.description,
          label_ids: card.labelIds,
          priority: card.priority,
          due_date: card.dueDate,
          checklist: card.checklist,
          progress: card.progress,
          progress_log: card.progressLog,
          created_at: card.createdAt,
          updated_at: card.updatedAt,
        },
      ]
    }),
  )
}

const byPosition = (a: { position: number; id: string }, b: { position: number; id: string }) =>
  a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Rebuild a board from database rows. Order comes from `position`, ties broken by id. */
export function docFromRows(board: BoardRow, columnRowList: ColumnRow[], cardRowList: CardRow[]): BoardDoc {
  const columns = [...columnRowList].sort(byPosition)
  const cardsByColumn = new Map<string, CardRow[]>()
  for (const row of cardRowList) {
    const list = cardsByColumn.get(row.column_id) ?? []
    list.push(row)
    cardsByColumn.set(row.column_id, list)
  }
  const cards: Card[] = []
  const docColumns: Column[] = columns.map((row) => {
    const rows = (cardsByColumn.get(row.id) ?? []).sort(byPosition)
    for (const c of rows) {
      cards.push({
        id: c.id,
        title: c.title,
        description: c.description,
        labelIds: c.label_ids,
        priority: c.priority,
        dueDate: c.due_date,
        checklist: c.checklist,
        progress: c.progress ?? null,
        progressLog: c.progress_log ?? [],
        createdAt: c.created_at,
        updatedAt: c.updated_at,
      })
    }
    return { id: row.id, title: row.title, wipLimit: row.wip_limit, cardIds: rows.map((c) => c.id) }
  })
  return {
    board: {
      id: board.id,
      title: board.title,
      labels: board.labels,
      createdAt: board.created_at,
      columnIds: docColumns.map((c) => c.id),
    },
    columns: docColumns,
    cards,
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Compare two versions of a board and list only the rows that changed. */
export function diffBoardDoc(prev: BoardDoc, next: BoardDoc): BoardOps {
  const ops: BoardOps = { upsertColumns: [], deleteColumnIds: [], upsertCards: [], deleteCardIds: [] }
  if (prev.board.title !== next.board.title || !same(prev.board.labels, next.board.labels)) {
    ops.board = { title: next.board.title, labels: next.board.labels }
  }

  const prevColumns = new Map(columnRows(prev).map((row) => [row.id, row]))
  const nextColumns = columnRows(next)
  for (const row of nextColumns) {
    if (!same(prevColumns.get(row.id), row)) ops.upsertColumns.push(row)
  }
  const nextColumnIds = new Set(nextColumns.map((row) => row.id))
  ops.deleteColumnIds = [...prevColumns.keys()].filter((id) => !nextColumnIds.has(id))

  const prevCards = new Map(cardRows(prev).map((row) => [row.id, row]))
  const nextCards = cardRows(next)
  for (const row of nextCards) {
    if (!same(prevCards.get(row.id), row)) ops.upsertCards.push(row)
  }
  const nextCardIds = new Set(nextCards.map((row) => row.id))
  ops.deleteCardIds = [...prevCards.keys()].filter((id) => !nextCardIds.has(id))
  return ops
}

export function isEmptyOps(ops: BoardOps): boolean {
  return (
    !ops.board &&
    ops.upsertColumns.length === 0 &&
    ops.deleteColumnIds.length === 0 &&
    ops.upsertCards.length === 0 &&
    ops.deleteCardIds.length === 0
  )
}

export function sameDoc(a: BoardDoc, b: BoardDoc): boolean {
  return isEmptyOps(diffBoardDoc(a, b))
}

export interface BoardSummary {
  id: string
  role: Role
  /** Changes whenever anything on the board changes. */
  updatedAt: string
}
