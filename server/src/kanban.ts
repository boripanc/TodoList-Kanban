// Board, column and card operations for the REST API (/api/v1) and the MCP
// endpoint (/api/mcp). Both act as one user and get the same role checks as the
// app: viewers read, editors and owners change, only owners delete boards.
// Positions are renumbered here, so callers only say where things go.
import { randomUUID } from 'node:crypto'
import type { CardRow } from '../../src/cloud/doc.ts'
import type { TeamMember } from '../../src/types.ts'
import { isDoneColumn } from '../../src/lib/done.ts'
import { scheduleProblem } from '../../src/lib/schedule.ts'
import { computeWorkload, loadLevel, mergeWorkloads, type LoadLevel, type Workload } from '../../src/lib/workload.ts'
import { canEdit, canRead, fail, requireRole, type Role, type User } from './access.ts'
import type { Db, Queryable } from './db.ts'
import type {
  CardInput,
  CardQuery,
  ColumnInput,
  NewBoardInput,
  ProgressNoteInput,
  TeamMemberInput,
} from './validate.ts'

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
  /** When work starts (YYYY-MM-DD). */
  startDate: string | null
  /** When it is due: the end date (YYYY-MM-DD). */
  dueDate: string | null
  labels: ApiLabel[]
  /** Team members the card is assigned to. */
  assignees: { id: string; name: string }[]
  checklist: { id: string; text: string; done: boolean }[]
  /** 0-100, or null when the card doesn't track progress. */
  progress: number | null
  /** Progress updates, oldest first. */
  progressLog: { id: string; text: string; progress: number | null; at: string }[]
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
  /** People cards can be assigned to; capacity is how many open cards they can take on (0 = no limit). */
  team: TeamMember[]
  createdAt: string
  updatedAt: string
  columns: ApiColumn[]
}

export interface ApiWorkloadCard {
  id: string
  title: string
  boardId: string
  board: string
  column: string
  priority: CardRow['priority']
  dueDate: string | null
  progress: number | null
}

export interface ApiMemberLoad {
  /** One id per board when people with the same name are joined across boards. */
  memberIds: string[]
  name: string
  color: string
  capacity: number
  level: LoadLevel
  openCount: number
  overdue: number
  dueSoon: number
  doneCount: number
  openCards: ApiWorkloadCard[]
}

export interface ApiWorkload {
  boards: { id: string; title: string }[]
  members: ApiMemberLoad[]
  unassigned: ApiWorkloadCard[]
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
type BoardDbRow = {
  id: string
  title: string
  labels: ApiLabel[]
  team: TeamMember[]
  created_at: string | number
  updated_at: Date
}

const iso = (value: string | number | Date) => new Date(value instanceof Date ? value : Number(value)).toISOString()

function toApiCard(
  row: CardDbRow,
  column: { id: string; title: string },
  labels: ApiLabel[],
  team: TeamMember[],
): ApiCard {
  const byId = new Map(labels.map((l) => [l.id, l]))
  const people = new Map(team.map((m) => [m.id, m]))
  return {
    id: row.id,
    boardId: row.board_id,
    columnId: column.id,
    column: column.title,
    position: row.position,
    title: row.title,
    description: row.description,
    priority: row.priority,
    startDate: row.start_date ?? null,
    dueDate: row.due_date,
    labels: row.label_ids.flatMap((id) => byId.get(id) ?? []),
    assignees: (row.assignee_ids ?? []).flatMap((id) => {
      const m = people.get(id)
      return m ? [{ id: m.id, name: m.name }] : []
    }),
    checklist: row.checklist,
    progress: row.progress ?? null,
    progressLog: (row.progress_log ?? []).map((e) => ({ ...e, at: iso(e.at) })),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

const byPosition = (a: { position: number; id: string }, b: { position: number; id: string }) =>
  a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

async function loadBoard(q: Queryable, boardId: string, role: Role): Promise<ApiBoard> {
  const [boards, columns, cards] = await Promise.all([
    q.query<BoardDbRow>('select id, title, labels, team, created_at, updated_at from kanban.boards where id = $1', [
      boardId,
    ]),
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
      .map((card, index) => ({ ...toApiCard(card, col, board.labels, board.team), position: index })),
  }))
  return {
    id: board.id,
    title: board.title,
    role,
    labels: board.labels,
    team: board.team,
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

/** Team member ids for ids or names, adding a team member for each name the board doesn't have yet. */
async function resolveAssignees(tx: Queryable, boardId: string, wanted: string[]): Promise<string[]> {
  const { rows } = await tx.query<{ team: TeamMember[] }>('select team from kanban.boards where id = $1', [boardId])
  const team = [...(rows[0]?.team ?? [])]
  const ids: string[] = []
  for (const want of wanted) {
    let member = findMember(team, want)
    if (!member) {
      member = { id: randomUUID(), name: want, color: labelColors[team.length % labelColors.length], capacity: 0 }
      team.push(member)
    }
    if (!ids.includes(member.id)) ids.push(member.id)
  }
  if (team.length !== rows[0]?.team.length) {
    await tx.query('update kanban.boards set team = $2 where id = $1', [boardId, JSON.stringify(team)])
  }
  return ids
}

const findMember = (team: TeamMember[], ref: string) =>
  team.find((m) => m.id === ref) ?? team.find((m) => m.name.toLowerCase() === ref.toLowerCase())

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
    const assigneeIds = await resolveAssignees(tx, boardId, input.assignees ?? [])
    await checkSchedule(tx, boardId, labelIds, { startDate: input.startDate ?? null, dueDate: input.dueDate ?? null })
    const now = Date.now()
    await tx.query(
      `insert into kanban.cards (id, board_id, column_id, position, title, description, label_ids, priority, due_date,
         checklist, created_at, updated_at, progress, assignee_ids, start_date)
       values ($1, $2, $3, 0, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12, $13)`,
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
        input.progress ?? null,
        JSON.stringify(assigneeIds),
        input.startDate ?? null,
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
    const assigneeIds = input.assignees ? await resolveAssignees(tx, boardId, input.assignees) : card.assignee_ids
    const startDate = input.startDate === undefined ? (card.start_date ?? null) : input.startDate
    const dueDate = input.dueDate === undefined ? card.due_date : input.dueDate
    // Only changes to labels or dates are checked, so older cards can still be moved and renamed.
    if (input.labels || input.startDate !== undefined || input.dueDate !== undefined)
      await checkSchedule(tx, boardId, labelIds, { startDate, dueDate })
    await tx.query(
      `update kanban.cards set title = $2, description = $3, priority = $4, due_date = $5, label_ids = $6,
         checklist = $7, updated_at = $8, progress = $9, assignee_ids = $10, start_date = $11
       where id = $1`,
      [
        cardId,
        input.title ?? card.title,
        input.description ?? card.description,
        input.priority ?? card.priority,
        dueDate,
        JSON.stringify(labelIds),
        JSON.stringify(input.checklist ? checklistFrom(input.checklist, card.checklist) : card.checklist),
        Date.now(),
        input.progress === undefined ? card.progress : input.progress,
        JSON.stringify(assigneeIds ?? []),
        startDate,
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

/** Refuse dates that don't fit the card's labels: R4C and Project cards need a start and an end date. */
async function checkSchedule(
  q: Queryable,
  boardId: string,
  labelIds: string[],
  dates: { startDate: string | null; dueDate: string | null },
) {
  const { rows } = await q.query<{ labels: ApiLabel[] }>('select labels from kanban.boards where id = $1', [boardId])
  const names = (rows[0]?.labels ?? []).filter((l) => labelIds.includes(l.id)).map((l) => l.name)
  const problem = scheduleProblem(dates, names)
  if (problem) fail(400, `${problem} Give startDate and dueDate (the end date) as YYYY-MM-DD.`)
}

/** Add a progress update to a card; a given progress also becomes the card's progress. */
export async function addProgressNote(db: Db, user: User, cardId: string, input: ProgressNoteInput): Promise<ApiCard> {
  const boardId = await db.transaction(async (tx) => {
    const boardId = await cardBoard(tx, user, cardId, canEdit)
    const now = Date.now()
    const entry = { id: randomUUID(), text: input.text, progress: input.progress ?? null, at: now }
    await tx.query(
      `update kanban.cards set progress_log = progress_log || $2::jsonb, progress = coalesce($3, progress), updated_at = $4
       where id = $1`,
      [cardId, JSON.stringify([entry]), input.progress ?? null, now],
    )
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
  if (query.assignee?.toLowerCase() === 'none') where.push(`jsonb_array_length(c.assignee_ids) = 0`)
  else if (query.assignee) {
    const p = param(query.assignee)
    where.push(`exists (select 1 from jsonb_array_elements(b.team) m
      where (m->>'id' = ${p} or lower(m->>'name') = lower(${p})) and c.assignee_ids @> jsonb_build_array(m->>'id'))`)
  }
  if (query.priority) where.push(`c.priority = ${param(query.priority)}`)
  if (query.dueFrom) where.push(`c.due_date >= ${param(query.dueFrom)}`)
  if (query.dueTo) where.push(`c.due_date <= ${param(query.dueTo)}`)
  if (query.search) {
    const p = param(`%${query.search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`)
    where.push(`(c.title ilike ${p} or c.description ilike ${p} or c.checklist::text ilike ${p} or c.progress_log::text ilike ${p})`)
  }
  const { rows } = await db.query<CardDbRow & { column_title: string; labels: ApiLabel[]; team: TeamMember[] }>(
    `select c.*, col.title as column_title, b.labels, b.team
     from kanban.cards c
     join kanban.board_members m on m.board_id = c.board_id and m.user_id = $1
     join kanban.boards b on b.id = c.board_id
     join kanban.columns col on col.id = c.column_id
     ${where.length ? `where ${where.join(' and ')}` : ''}
     order by lower(b.title), b.id, col.position, col.id, c.position, c.id
     limit ${param(query.limit)}`,
    params,
  )
  return rows.map((row) => toApiCard(row, { id: row.column_id, title: row.column_title }, row.labels, row.team))
}

// --- Team and workload ---

/**
 * Add a team member to a board, or change one. `member` is an id or a name;
 * a name the board doesn't have yet adds that person.
 */
export async function setTeamMember(
  db: Db,
  user: User,
  boardId: string,
  member: string,
  input: TeamMemberInput,
): Promise<TeamMember> {
  return db.transaction(async (tx) => {
    await requireRole(tx, boardId, user.id, canEdit)
    const { rows } = await tx.query<{ team: TeamMember[] }>('select team from kanban.boards where id = $1 for update', [
      boardId,
    ])
    const team = [...(rows[0]?.team ?? [])]
    const existing = findMember(team, member)
    const name = input.name ?? existing?.name ?? member
    const clash = team.find((m) => m !== existing && m.name.toLowerCase() === name.toLowerCase())
    if (clash) fail(409, `${clash.name} is already on this board's team`)
    const next: TeamMember = {
      id: existing?.id ?? randomUUID(),
      name,
      color: input.color ?? existing?.color ?? labelColors[team.length % labelColors.length],
      capacity: input.capacity ?? existing?.capacity ?? 0,
    }
    if (existing) team[team.indexOf(existing)] = next
    else team.push(next)
    await tx.query('update kanban.boards set team = $2 where id = $1', [boardId, JSON.stringify(team)])
    return next
  })
}

/** Take someone off a board's team and off every card they were assigned to. */
export async function removeTeamMember(db: Db, user: User, boardId: string, member: string) {
  await db.transaction(async (tx) => {
    await requireRole(tx, boardId, user.id, canEdit)
    const { rows } = await tx.query<{ team: TeamMember[] }>('select team from kanban.boards where id = $1 for update', [
      boardId,
    ])
    const team = rows[0]?.team ?? []
    const existing = findMember(team, member) ?? fail(404, `Team member "${member}" not found on this board`)
    await tx.query('update kanban.boards set team = $2 where id = $1', [
      boardId,
      JSON.stringify(team.filter((m) => m.id !== existing.id)),
    ])
    await tx.query(
      `update kanban.cards set assignee_ids = assignee_ids - $2::text
       where board_id = $1 and assignee_ids @> jsonb_build_array($2::text)`,
      [boardId, existing.id],
    )
  })
}

/**
 * Who has what: each team member's open cards (not in a done column) against
 * their capacity, on one board or across every board the user can see. Across
 * boards, people with the same name count as one person.
 */
export async function getWorkload(db: Db, user: User, boardId?: string): Promise<ApiWorkload> {
  const ids = boardId
    ? [await requireRole(db, boardId, user.id, canRead).then(() => boardId)]
    : (await listBoards(db, user)).map((b) => b.id)
  const boards = await Promise.all(ids.map((id) => loadBoard(db, id, 'viewer')))
  type Item = ApiWorkloadCard & { assigneeIds: string[] }
  const workloads: Workload<Item>[] = boards.map((board) =>
    computeWorkload(
      board.team,
      board.columns.flatMap((col) =>
        col.cards.map((card) => ({
          done: isDoneColumn(col.title),
          card: {
            id: card.id,
            title: card.title,
            boardId: board.id,
            board: board.title,
            column: col.title,
            priority: card.priority,
            dueDate: card.dueDate,
            progress: card.progress,
            assigneeIds: card.assignees.map((a) => a.id),
          },
        })),
      ),
    ),
  )
  const workload = boardId ? workloads[0] : mergeWorkloads(workloads)
  const strip = ({ assigneeIds: _a, ...card }: Item): ApiWorkloadCard => card
  return {
    boards: boards.map((b) => ({ id: b.id, title: b.title })),
    members: workload.members.map((m) => ({
      memberIds: m.memberIds,
      name: m.name,
      color: m.color,
      capacity: m.capacity,
      level: loadLevel(m),
      openCount: m.open.length,
      overdue: m.overdue,
      dueSoon: m.dueSoon,
      doneCount: m.doneCount,
      openCards: m.open.map(strip),
    })),
    unassigned: workload.unassigned.map(strip),
  }
}
