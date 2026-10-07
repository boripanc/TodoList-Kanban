import type { BoardOps, BoardRow, CardRow, ColumnRow } from '../../src/cloud/doc.ts'

/** Thrown for a request body that doesn't have the expected shape; becomes a 400. */
export class BadRequest extends Error {}

type Json = Record<string, unknown>

function obj(value: unknown, what: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new BadRequest(`${what} must be an object`)
  return value as Json
}

function str(value: unknown, what: string, max = 500): string {
  if (typeof value !== 'string' || value.length > max)
    throw new BadRequest(`${what} must be text up to ${max} characters`)
  return value
}

function id(value: unknown, what: string): string {
  const s = str(value, what, 100)
  if (!s) throw new BadRequest(`${what} is required`)
  return s
}

function int(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new BadRequest(`${what} must be a whole number`)
  return value
}

function arr(value: unknown, what: string, max = 1000): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new BadRequest(`${what} must be a list`)
  return value
}

const priorities = ['none', 'low', 'medium', 'high', 'urgent'] as const

export function labels(value: unknown): BoardRow['labels'] {
  return arr(value, 'labels', 200).map((item) => {
    const l = obj(item, 'label')
    return { id: id(l.id, 'label id'), name: str(l.name, 'label name', 100), color: str(l.color, 'label color', 50) }
  })
}

export function boardRow(value: unknown): BoardRow {
  const b = obj(value, 'board')
  return {
    id: id(b.id, 'board id'),
    title: str(b.title, 'title'),
    labels: labels(b.labels),
    created_at: int(b.created_at, 'created_at'),
  }
}

export function columnRow(value: unknown, boardId: string): ColumnRow {
  const c = obj(value, 'column')
  return {
    id: id(c.id, 'column id'),
    board_id: boardId,
    position: int(c.position, 'position'),
    title: str(c.title, 'column title'),
    wip_limit: Math.max(0, int(c.wip_limit, 'wip_limit')),
  }
}

export function cardRow(value: unknown, boardId: string): CardRow {
  const c = obj(value, 'card')
  const priority = c.priority as CardRow['priority']
  if (!priorities.includes(priority)) throw new BadRequest('Unknown priority')
  return {
    id: id(c.id, 'card id'),
    board_id: boardId,
    column_id: id(c.column_id, 'column_id'),
    position: int(c.position, 'position'),
    title: str(c.title, 'card title', 1000),
    description: str(c.description, 'description', 50_000),
    label_ids: arr(c.label_ids, 'label_ids', 200).map((l) => id(l, 'label id')),
    priority,
    due_date: c.due_date === null ? null : str(c.due_date, 'due_date', 10),
    checklist: arr(c.checklist, 'checklist', 500).map((item) => {
      const i = obj(item, 'checklist item')
      if (typeof i.done !== 'boolean') throw new BadRequest('checklist done must be true or false')
      return { id: id(i.id, 'checklist id'), text: str(i.text, 'checklist text', 1000), done: i.done }
    }),
    created_at: int(c.created_at, 'created_at'),
    updated_at: int(c.updated_at, 'updated_at'),
  }
}

export function boardOps(value: unknown, boardId: string): BoardOps {
  const o = obj(value, 'changes')
  const board = o.board === undefined ? undefined : obj(o.board, 'board')
  return {
    board: board && { title: str(board.title, 'title'), labels: labels(board.labels) },
    upsertColumns: arr(o.upsertColumns ?? [], 'upsertColumns').map((c) => columnRow(c, boardId)),
    deleteColumnIds: arr(o.deleteColumnIds ?? [], 'deleteColumnIds').map((c) => id(c, 'column id')),
    upsertCards: arr(o.upsertCards ?? [], 'upsertCards', 5000).map((c) => cardRow(c, boardId)),
    deleteCardIds: arr(o.deleteCardIds ?? [], 'deleteCardIds', 5000).map((c) => id(c, 'card id')),
  }
}

export function inviteRole(value: unknown): 'editor' | 'viewer' {
  if (value !== 'editor' && value !== 'viewer') throw new BadRequest('Role must be editor or viewer')
  return value
}

export function email(value: unknown): string {
  const s = str(value, 'email', 320).trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new BadRequest('Enter a valid email address')
  return s
}

export function arrOf<T>(value: unknown, parse: (item: unknown) => T, max = 5000): T[] {
  return arr(value ?? [], 'list', max).map(parse)
}

export function uuid(value: unknown): string {
  const s = str(value, 'id', 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) throw new BadRequest('Unknown id')
  return s
}

// --- REST API and MCP tool input (server/src/kanban.ts) ---

export interface NewBoardInput {
  title: string
  columns: string[]
  labels: { name: string; color?: string }[]
}

export interface ColumnInput {
  title?: string
  wipLimit?: number
  position?: number
}

export interface CardInput {
  /** Column id or title. */
  column?: string
  position?: number
  title?: string
  description?: string
  priority?: CardRow['priority']
  dueDate?: string | null
  /** Label ids or names; unknown names become new labels. */
  labels?: string[]
  checklist?: { text: string; done: boolean }[]
}

export interface CardQuery {
  boardId?: string
  column?: string
  label?: string
  priority?: CardRow['priority']
  search?: string
  dueFrom?: string
  dueTo?: string
  limit: number
}

const optional = <T>(value: unknown, parse: (value: unknown) => T): T | undefined =>
  value === undefined ? undefined : parse(value)

function title(value: unknown, what: string, max = 500): string {
  const s = str(value, what, max).trim()
  if (!s) throw new BadRequest(`${what} is required`)
  return s
}

function wholeAtLeastZero(value: unknown, what: string): number {
  const n = int(value, what)
  if (n < 0) throw new BadRequest(`${what} must be 0 or more`)
  return n
}

function priority(value: unknown): CardRow['priority'] {
  if (!priorities.includes(value as CardRow['priority']))
    throw new BadRequest(`priority must be one of ${priorities.join(', ')}`)
  return value as CardRow['priority']
}

function date(value: unknown, what: string): string {
  const s = str(value, what, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s)))
    throw new BadRequest(`${what} must be a date like 2026-12-31`)
  return s
}

const color = (value: unknown) => {
  const s = str(value, 'label color', 50)
  if (!/^#[0-9a-f]{6}$/i.test(s)) throw new BadRequest('label color must look like #0090ff')
  return s
}

export function newBoardInput(value: unknown): NewBoardInput {
  const b = obj(value, 'board')
  return {
    title: title(b.title, 'title'),
    columns: optional(b.columns, (v) => arr(v, 'columns', 50).map((c) => title(c, 'column title'))) ?? [
      'To do',
      'In progress',
      'Done',
    ],
    labels:
      optional(b.labels, (v) =>
        arr(v, 'labels', 200).map((item) => {
          const l = obj(item, 'label')
          return { name: title(l.name, 'label name', 100), color: optional(l.color, color) }
        }),
      ) ?? [],
  }
}

export function boardPatchInput(value: unknown): { title?: string } {
  const b = obj(value, 'board')
  return { title: optional(b.title, (v) => title(v, 'title')) }
}

export function columnInput(value: unknown, isNew: boolean): ColumnInput {
  const c = obj(value, 'column')
  return {
    title: isNew ? title(c.title, 'title') : optional(c.title, (v) => title(v, 'title')),
    wipLimit: optional(c.wipLimit, (v) => wholeAtLeastZero(v, 'wipLimit')),
    position: optional(c.position, (v) => wholeAtLeastZero(v, 'position')),
  }
}

export function cardInput(value: unknown, isNew: boolean): CardInput {
  const c = obj(value, 'card')
  return {
    column: isNew ? title(c.column, 'column', 500) : optional(c.column, (v) => title(v, 'column', 500)),
    position: optional(c.position, (v) => wholeAtLeastZero(v, 'position')),
    title: isNew ? title(c.title, 'title', 1000) : optional(c.title, (v) => title(v, 'title', 1000)),
    description: optional(c.description, (v) => str(v, 'description', 50_000)),
    priority: optional(c.priority, priority),
    dueDate: optional(c.dueDate, (v) => (v === null || v === '' ? null : date(v, 'dueDate'))),
    labels: optional(c.labels, (v) => arr(v, 'labels', 200).map((l) => title(l, 'label', 100))),
    checklist: optional(c.checklist, (v) =>
      arr(v, 'checklist', 500).map((item) => {
        if (typeof item === 'string') return { text: title(item, 'checklist text', 1000), done: false }
        const i = obj(item, 'checklist item')
        if (i.done !== undefined && typeof i.done !== 'boolean')
          throw new BadRequest('checklist done must be true or false')
        return { text: title(i.text, 'checklist text', 1000), done: i.done === true }
      }),
    ),
  }
}

/** Card filters, from a query string (all text) or from MCP tool arguments. */
export function cardQuery(value: unknown): CardQuery {
  const q = obj(value, 'query')
  const text = (v: unknown, what: string) => (v === '' ? undefined : str(v, what, 500))
  const limit = optional(q.limit, (v) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : int(v, 'limit')))
  return {
    boardId: optional(q.boardId, (v) => text(v, 'boardId')),
    column: optional(q.column, (v) => text(v, 'column')),
    label: optional(q.label, (v) => text(v, 'label')),
    priority: optional(q.priority, (v) => (v === '' ? undefined : priority(v))),
    search: optional(q.search, (v) => text(v, 'search')),
    dueFrom: optional(q.dueFrom, (v) => (v === '' ? undefined : date(v, 'dueFrom'))),
    dueTo: optional(q.dueTo, (v) => (v === '' ? undefined : date(v, 'dueTo'))),
    limit: Math.min(Math.max(limit ?? 100, 1), 500),
  }
}

export function tokenName(value: unknown): string {
  return title(value, 'name', 100)
}

/** A board, card or column reference in MCP tool arguments. */
export function ref(value: unknown, what: string): string {
  return id(value, what)
}
