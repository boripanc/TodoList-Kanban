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
