// Board, column and card operations for the REST API (/api/v1) and the MCP
// endpoint (/api/mcp). Both act as one user and get the same role checks as the
// app: viewers read, editors and owners change, only owners delete boards.
// Positions are renumbered here, so callers only say where things go.
import { randomUUID } from 'node:crypto'
import type { CardRow } from '../../src/cloud/doc.ts'
import { canEdit, canRead, fail, requireRole, type Role, type User } from './access.ts'
import type { Db, Queryable } from './db.ts'
import type { CardInput, CardQuery, ColumnInput, NewBoardInput } from './validate.ts'

export interface ApiLabel {
  id: string
  name: string
  color: string
}

export interface ApiCard {
  id: string
  boardId: string
  columnId: string
  column: string
  position: number
  title: string
  description: string
  priority: CardRow['priority']
  dueDate: string | null
  labels: ApiLabel[]
  checklist: { id: string; text: string; done: boolean }[]
  createdAt: string
  updatedAt: string
}

export interface ApiColumn {
  id: string
  title: string
  wipLimit: number
  position: number
  cards: ApiCard[]
}

export interface ApiBoard {
  id: string
  title: string
  role: Role
  labels: ApiLabel[]
  createdAt: string
  updatedAt: string
  columns: ApiColumn[]
}

export interface ApiBoardSummary {
  id: string
  title: string
  role: Role
  cardCount: number
  updatedAt: string
}

// The app's label palette (src/state/templates.ts), for labels created by name.
const labelColors = ['#e5484d', '#f76b15', '#ffc53d', '#30a46c', '#12a594', '#0090ff', '#8e4ec6', '#d6409f', '#8b8d98']

type CardDbRow = CardRow & { created_at: string | number; updated_at: string | number }
type ColumnDbRow = { id: string; title: string; wip_limit: number; position: number }
type BoardDbRow = { id: string; title: string; labels: ApiLabel[]; created_at: string | number; updated_at: Date }

const iso = (value: string | number | Date) => new Date(value instanceof Date ? value : Number(value)).toISOString()

function toApiCard(row: CardDbRow, column: { id: string; title: string }, labels: ApiLabel[]): ApiCard {
  const byId = new Map(labels.map((l) => [l.id, l]))
  return {
    id: row.id,
    boardId: row.board_id,
    columnId: column.id,
    column: column.title,
    position: row.position,
    title: row.title,
    description: row.description,
    priority: row.priority,
    dueDate: row.due_date,
    labels: row.label_ids.flatMap((id) => byId.get(id) ?? []),
    checklist: row.checklist,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

const byPosition = (a: { position: number; id: string }, b: { position: number; id: string }) =>
  a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

async function loadBoard(q: Queryable, boardId: string, role: Role): Promise<ApiBoard> {
  const [boards, columns, cards] = await Promise.all([
    q.query<BoardDbRow>('select id, title, labels, created_at, updated_at from kanban.boards where id = $1', [boardId]),
    q.query<ColumnDbRow>('select id, title, wip_limit, position from kanban.columns where board_id = $1', [boardId]),
    q.query<CardDbRow>('select * from kanban.cards where board_id = $1', [boardId]),
  ])
  const board = boards.rows[0]
  if (!board) return fail(404, 'Board not found')
  const apiColumns = columns.rows.sort(byPosition).map((col, position) => ({
    id: col.id,
    title: col.title,
    wipLimit: col.wip_limit,
    position,
    cards: cards.rows
      .filter((card) => card.column_id === col.id)
      .sort(byPosition)
      .map((card, index) => ({ ...toApiCard(card, col, board.labels), position: index })),
  }))
  return {
    id: board.id,
    title: board.title,
    role,
    labels: board.labels,
    createdAt: iso(board.created_at),
    updatedAt: iso(board.updated_at),
    columns: apiColumns,
  }
}

/** Serialize writes to one board, so concurrent calls don't hand out the same position. */
async function lockBoard(tx: Queryable, boardId: string) {
  await tx.query('select id from kanban.boards where id = $1 for update', [boardId])
}

async function findColumn(q: Queryable, boardId: string, column: string): Promise<ColumnDbRow> {
  const { rows } = await q.query<ColumnDbRow>(
    `select id, title, wip_limit, position from kanban.columns where board_id = $1 and (id = $2 or lower(title) = lower($2))
     order by (id = $2) desc, position limit 1`,
    [boardId, column],
  )
  if (!rows[0]) fail(404, `Column "${column}" not found on this board`)
  return rows[0]
}

/** Put an item at `position` (default: the end) among its siblings, renumbering them 0, 1, 2... */
async function place(
  tx: Queryable,
  table: 'columns' | 'cards',
  siblings: { id: string; position: number }[],
  id: string,
  position: number | undefined,
) {
  const order = siblings
    .filter((s) => s.id !== id)
    .sort(byPosition)
    .map((s) => s.id)
  order.splice(Math.min(position ?? order.length, order.length), 0, id)
  const current = new Map(siblings.map((s) => [s.id, s.position]))
  for (const [index, itemId] of order.entries()) {
    if (current.get(itemId) !== index || itemId === id) {
      await tx.query(`update kanban.${table} set position = $2 where id = $1`, [itemId, index])
    }
  }
}

async function placeCard(tx: Queryable, boardId: string, cardId: string, columnId: string, position?: number) {
  const { rows } = await tx.query<{ id: string; position: number }>(
    'select id, position from kanban.cards where board_id = $1 and column_id = $2',
    [boardId, columnId],
  )
  await tx.query('update kanban.cards set column_id = $2 where id = $1 and board_id = $3', [cardId, columnId, boardId])
  await place(tx, 'cards', rows, cardId, position)
}

/** Close the gap a card leaves in the column it moved out of. */
async function renumberCards(tx: Queryable, boardId: string, columnId: string) {
  const { rows } = await tx.query<{ id: string; position: number }>(
    'select id, position from kanban.cards where board_id = $1 and column_id = $2',
    [boardId, columnId],
  )
  for (const [index, row] of rows.sort(byPosition).entries()) {
    if (row.position !== index) await tx.query('update kanban.cards set position = $2 where id = $1', [row.id, index])
  }
}

/** Label ids for ids or names, adding a label for each name the board doesn't have yet. */
async function resolveLabels(tx: Queryable, boardId: string, wanted: string[]): Promise<string[]> {
  const { rows } = await tx.query<{ labels: ApiLabel[] }>('select labels from kanban.boards where id = $1', [boardId])
  const labels = [...(rows[0]?.labels ?? [])]
  const ids: string[] = []
  for (const want of wanted) {
    let label = labels.find((l) => l.id === want) ?? labels.find((l) => l.name.toLowerCase() === want.toLowerCase())
    if (!label) {
      label = { id: randomUUID(), name: want, color: labelColors[labels.length % labelColors.length] }
      labels.push(label)
    }
    if (!ids.includes(label.id)) ids.push(label.id)
  }
  if (labels.length !== rows[0]?.labels.length) {
    await tx.query('update kanban.boards set labels = $2 where id = $1', [boardId, JSON.stringify(labels)])
  }
  return ids
}

function checklistFrom(input: { text: string; done: boolean }[], previous: CardRow['checklist'] = []) {
  // Keep the ids of items whose text is unchanged, so the app keeps them as the same items.
  const unused = [...previous]
  return input.map((item) => {
    const index = unused.findIndex((p) => p.text === item.text)
    const id = index >= 0 ? unused.splice(index, 1)[0].id : randomUUID()
    return { id, text: item.text, done: item.done }
  })
}

// --- Boards ---

export async function listBoards(db: Db, user: User): Promise<ApiBoardSummary[]> {
  const { rows } = await db.query<{ id: string; title: string; role: Role; updated_at: Date; card_count: string }>(
    `select b.id, b.title, m.role, b.updated_at,
       (select count(*) from kanban.cards c where c.board_id = b.id) as card_count
     from kanban.board_members m join kanban.boards b on b.id = m.board_id
     where m.user_id = $1 order by lower(b.title), b.id`,
    [user.id],
  )
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    role: r.role,
    cardCount: Number(r.card_count),
    updatedAt: iso(r.updated_at),
  }))
}

export async function getBoard(db: Db, user: User, boardId: string): Promise<ApiBoard> {
  const role = await requireRole(db, boardId, user.id, canRead)
  return loadBoard(db, boardId, role)
}

export async function createBoard(db: Db, user: User, input: NewBoardInput): Promise<ApiBoard> {
  const boardId = randomUUID()
  const labels = input.labels.map((l, i) => ({
    id: randomUUID(),
    name: l.name,
    color: l.color ?? labelColors[i % labelColors.length],
  }))
  await db.transaction(async (tx) => {
    await tx.query(
      'insert into kanban.boards (id, owner_id, title, labels, created_at) values ($1, $2, $3, $4, $5)',
      [boardId, user.id, input.title, JSON.stringify(labels), Date.now()],
    )
    await tx.query("insert into kanban.board_members (board_id, user_id, role) values ($1, $2, 'owner')", [
      boardId,
      user.id,
    ])
    for (const [position, title] of input.columns.entries()) {
      await tx.query('insert into kanban.columns (id, board_id, position, title) values ($1, $2, $3, $4)', [
        randomUUID(),
        boardId,
        position,
        title,
      ])
    }
  })
  return loadBoard(db, boardId, 'owner')
}

export async function updateBoard(db: Db, user: User, boardId: string, patch: { title?: string }) {
  const role = await db.transaction(async (tx) => {
    const role = await requireRole(tx, boardId, user.id, canEdit)
    if (patch.title !== undefined) {
      await tx.query('update kanban.boards set title = $2 where id = $1', [boardId, patch.title])
    }
    return role
  })
  return loadBoard(db, boardId, role)
}

export async function deleteBoard(db: Db, user: User, boardId: string) {
  await requireRole(db, boardId, user.id, ['owner'])
  await db.query('delete from kanban.boards where id = $1', [boardId])
}

// --- Columns ---

export async function createColumn(db: Db, user: User, boardId: string, input: ColumnInput): Promise<ApiColumn> {
  const id = randomUUID()
  await db.transaction(async (tx) => {
    await requireRole(tx, boardId, user.id, canEdit)
    await lockBoard(tx, boardId)
    const { rows } = await tx.query<{ id: string; position: number }>(
      'select id, position from kanban.columns where board_id = $1',
      [boardId],
    )
    await tx.query('insert into kanban.columns (id, board_id, position, title, wip_limit) values ($1, $2, $3, $4, $5)', [
      id,
      boardId,
      rows.length,
      input.title,
      input.wipLimit ?? 0,
    ])
    await place(tx, 'columns', rows, id, input.position)
  })
  return columnOf(db, boardId, id)
}

async function columnOf(db: Db, boardId: string, columnId: string): Promise<ApiColumn> {
  const board = await loadBoard(db, boardId, 'viewer')
  return board.columns.find((c) => c.id === columnId) ?? fail(404, 'Column not found')
}

export async function updateColumn(
  db: Db,
  user: User,
  boardId: string,
  column: string,
  input: ColumnInput,
): Promise<ApiColumn> {
  const id = await db.transaction(async (tx) => {
    await requireRole(tx, boardId, user.id, canEdit)
    await lockBoard(tx, boardId)
    const col = await findColumn(tx, boardId, column)
    if (input.title !== undefined || input.wipLimit !== undefined) {
      await tx.query('update kanban.columns set title = $2, wip_limit = $3 where id = $1', [
        col.id,
        input.title ?? col.title,
        input.wipLimit ?? col.wip_limit,
      ])
    }
    if (input.position !== undefined) {
      const { rows } = await tx.query<{ id: string; position: number }>(
        'select id, position from kanban.columns where board_id = $1',
        [boardId],
      )
      await place(tx, 'columns', rows, col.id, input.position)
    }
    return col.id
  })
  return columnOf(db, boardId, id)
}

/** Deletes the column and every card in it. */
export async function deleteColumn(db: Db, user: User, boardId: string, column: string) {
  await db.transaction(async (tx) => {
    await requireRole(tx, boardId, user.id, canEdit)
    const col = await findColumn(tx, boardId, column)
    await tx.query('delete from kanban.columns where id = $1 and board_id = $2', [col.id, boardId])
  })
}

// --- Cards ---

/** The board a card is on, refusing (as "not found") cards on boards the user can't see. */
async function cardBoard(q: Queryable, user: User, cardId: string, allowed: Role[]): Promise<string> {
  const { rows } = await q.query<{ board_id: string }>('select board_id from kanban.cards where id = $1', [cardId])
  if (!rows[0]) fail(404, 'Card not found')
  try {
    await requireRole(q, rows[0].board_id, user.id, allowed)
  } catch (error) {
    // Don't confirm that a card exists on someone else's board.
    if (error instanceof Error && 'status' in error && error.status === 404) fail(404, 'Card not found')
    throw error
  }
  return rows[0].board_id
}

export async function getCard(db: Db, user: User, cardId: string): Promise<ApiCard> {
  const boardId = await cardBoard(db, user, cardId, canRead)
  return cardOf(db, boardId, cardId)
}

async function cardOf(db: Db, boardId: string, cardId: string): Promise<ApiCard> {
  const board = await loadBoard(db, boardId, 'viewer')
  return board.columns.flatMap((c) => c.cards).find((c) => c.id === cardId) ?? fail(404, 'Card not found')
}

export async function createCard(db: Db, user: User, boardId: string, input: CardInput): Promise<ApiCard> {
  const id = randomUUID()
  await db.transaction(async (tx) => {
    await requireRole(tx, boardId, user.id, canEdit)
    await lockBoard(tx, boardId)
    const column = await findColumn(tx, boardId, input.column!)
    const labelIds = await resolveLabels(tx, boardId, input.labels ?? [])
    const now = Date.now()
    await tx.query(
      `insert into kanban.cards (id, board_id, column_id, position, title, description, label_ids, priority, due_date,
         checklist, created_at, updated_at)
       values ($1, $2, $3, 0, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [
        id,
        boardId,
        column.id,
        input.title,
        input.description ?? '',
        JSON.stringify(labelIds),
        input.priority ?? 'none',
        input.dueDate ?? null,
        JSON.stringify(checklistFrom(input.checklist ?? [])),
        now,
      ],
    )
    await placeCard(tx, boardId, id, column.id, input.position)
  })
  return cardOf(db, boardId, id)
}

export async function updateCard(db: Db, user: User, cardId: string, input: CardInput): Promise<ApiCard> {
  const boardId = await db.transaction(async (tx) => {
    const boardId = await cardBoard(tx, user, cardId, canEdit)
    await lockBoard(tx, boardId)
    const { rows } = await tx.query<CardDbRow>('select * from kanban.cards where id = $1', [cardId])
    const card = rows[0]
    const labelIds = input.labels ? await resolveLabels(tx, boardId, input.labels) : card.label_ids
    await tx.query(
      `update kanban.cards set title = $2, description = $3, priority = $4, due_date = $5, label_ids = $6,
         checklist = $7, updated_at = $8
       where id = $1`,
      [
        cardId,
        input.title ?? card.title,
        input.description ?? card.description,
        input.priority ?? card.priority,
        input.dueDate === undefined ? card.due_date : input.dueDate,
        JSON.stringify(labelIds),
        JSON.stringify(input.checklist ? checklistFrom(input.checklist, card.checklist) : card.checklist),
        Date.now(),
      ],
    )
    if (input.column !== undefined || input.position !== undefined) {
      const columnId = input.column === undefined ? card.column_id : (await findColumn(tx, boardId, input.column)).id
      await placeCard(tx, boardId, cardId, columnId, input.position)
      if (columnId !== card.column_id) await renumberCards(tx, boardId, card.column_id)
    }
    return boardId
  })
  return cardOf(db, boardId, cardId)
}

export async function deleteCard(db: Db, user: User, cardId: string) {
  await db.transaction(async (tx) => {
    const boardId = await cardBoard(tx, user, cardId, canEdit)
    await lockBoard(tx, boardId)
    const { rows } = await tx.query<{ column_id: string }>(
      'delete from kanban.cards where id = $1 and board_id = $2 returning column_id',
      [cardId, boardId],
    )
    if (rows[0]) await renumberCards(tx, boardId, rows[0].column_id)
  })
}

/** Cards on the boards the user can see, filtered, in board order. */
export async function findCards(db: Db, user: User, query: CardQuery): Promise<ApiCard[]> {
  const params: unknown[] = [user.id]
  const where: string[] = []
  const param = (value: unknown) => `$${params.push(value)}`
  if (query.boardId) where.push(`c.board_id = ${param(query.boardId)}`)
  if (query.column) {
    const p = param(query.column)
    where.push(`(col.id = ${p} or lower(col.title) = lower(${p}))`)
  }
  if (query.label) {
    const p = param(query.label)
    where.push(`exists (select 1 from jsonb_array_elements(b.labels) l
      where (l->>'id' = ${p} or lower(l->>'name') = lower(${p})) and c.label_ids @> jsonb_build_array(l->>'id'))`)
  }
  if (query.priority) where.push(`c.priority = ${param(query.priority)}`)
  if (query.dueFrom) where.push(`c.due_date >= ${param(query.dueFrom)}`)
  if (query.dueTo) where.push(`c.due_date <= ${param(query.dueTo)}`)
  if (query.search) {
    const p = param(`%${query.search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`)
    where.push(`(c.title ilike ${p} or c.description ilike ${p} or c.checklist::text ilike ${p})`)
  }
  const { rows } = await db.query<CardDbRow & { column_title: string; labels: ApiLabel[] }>(
    `select c.*, col.title as column_title, b.labels
     from kanban.cards c
     join kanban.board_members m on m.board_id = c.board_id and m.user_id = $1
     join kanban.boards b on b.id = c.board_id
     join kanban.columns col on col.id = c.column_id
     ${where.length ? `where ${where.join(' and ')}` : ''}
     order by lower(b.title), b.id, col.position, col.id, c.position, c.id
     limit ${param(query.limit)}`,
    params,
  )
  return rows.map((row) => toApiCard(row, { id: row.column_id, title: row.column_title }, row.labels))
}
