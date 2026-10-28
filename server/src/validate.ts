import type { BoardOps, BoardRow, CardRow, ColumnRow } from '../../src/cloud/doc.ts'
import type { InterfaceSpec, ProgressEntry, TeamMember } from '../../src/types.ts'
import { adapterTypes, messageModes, SPEC_TEXT_MAX, specFields, specStatuses } from '../../src/lib/interfaces.ts'
import type { ContactInput, CredentialField, CredentialInput } from '../../src/cloud/api.ts'
import { credentialKinds, type CredentialKind } from '../../src/lib/credentials.ts'
import { MAX_ESTIMATE_DAYS } from '../../src/lib/schedule.ts'
import {
  attachmentCategories,
  attachmentProblem,
  attachmentTypes,
  extensionOf,
  type AttachmentCategory,
} from '../../src/lib/attachments.ts'

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

function percent(value: unknown, what: string): number | null {
  if (value === null) return null
  const n = int(value, what)
  if (n < 0 || n > 100) throw new BadRequest(`${what} must be from 0 to 100`)
  return n
}

/** Man-days: a positive number up to 999, or null. */
function estimate(value: unknown, what: string): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_ESTIMATE_DAYS)
    throw new BadRequest(`${what} must be a number of man-days above 0 and up to ${MAX_ESTIMATE_DAYS}`)
  return value
}

/** Part of an interface spec; every field is optional. */
export function specPatch(value: unknown, what: string): Partial<InterfaceSpec> {
  const s = obj(value, what)
  const patch: Partial<InterfaceSpec> = {}
  const oneOf = <T extends string>(key: keyof InterfaceSpec, allowed: readonly T[]): T | undefined => {
    if (s[key] === undefined) return undefined
    if (!allowed.includes(s[key] as T)) throw new BadRequest(`${what} ${key} must be one of ${allowed.join(', ')}`)
    return s[key] as T
  }
  const senderAdapter = oneOf('senderAdapter', adapterTypes)
  const receiverAdapter = oneOf('receiverAdapter', adapterTypes)
  const mode = oneOf('mode', messageModes)
  const status = oneOf('status', specStatuses)
  if (senderAdapter) patch.senderAdapter = senderAdapter
  if (receiverAdapter) patch.receiverAdapter = receiverAdapter
  if (mode) patch.mode = mode
  if (status) patch.status = status
  for (const { key } of specFields) {
    if (s[key] !== undefined) patch[key] = str(s[key], `${what} ${key}`, SPEC_TEXT_MAX)
  }
  return patch
}

/** A whole interface spec, as the app stores it. */
function spec(value: unknown): InterfaceSpec | null {
  if (value === null) return null
  const p = specPatch(value, 'spec')
  const keys = ['senderAdapter', 'receiverAdapter', 'mode', 'status', ...specFields.map((f) => f.key)] as const
  const missing = keys.filter((k) => p[k] === undefined)
  if (missing.length) throw new BadRequest(`spec needs ${missing.join(', ')}`)
  return p as InterfaceSpec
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

export function team(value: unknown): TeamMember[] {
  return arr(value, 'team', 200).map((item) => {
    const m = obj(item, 'team member')
    const capacity = int(m.capacity, 'capacity')
    if (capacity < 0 || capacity > 999) throw new BadRequest('capacity must be from 0 to 999')
    return {
      id: id(m.id, 'team member id'),
      name: str(m.name, 'team member name', 100),
      color: str(m.color, 'team member color', 50),
      capacity,
    }
  })
}

export function boardRow(value: unknown): BoardRow {
  const b = obj(value, 'board')
  return {
    id: id(b.id, 'board id'),
    title: str(b.title, 'title'),
    labels: labels(b.labels),
    // Apps from before teams existed leave it out; the database then keeps what it has.
    ...(b.team === undefined ? {} : { team: team(b.team) }),
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
    // Apps from before teams existed leave it out; the database then keeps what it has.
    ...(c.assignee_ids === undefined
      ? {}
      : { assignee_ids: arr(c.assignee_ids, 'assignee_ids', 200).map((a) => id(a, 'assignee id')) }),
    priority,
    // Apps from before start dates existed leave it out; the database then keeps what it has.
    ...(c.start_date === undefined
      ? {}
      : { start_date: c.start_date === null ? null : str(c.start_date, 'start_date', 10) }),
    due_date: c.due_date === null ? null : str(c.due_date, 'due_date', 10),
    // Apps from before estimates existed leave it out; the database then keeps what it has.
    ...(c.estimate_days === undefined ? {} : { estimate_days: estimate(c.estimate_days, 'estimate_days') }),
    checklist: arr(c.checklist, 'checklist', 500).map((item) => {
      const i = obj(item, 'checklist item')
      if (typeof i.done !== 'boolean') throw new BadRequest('checklist done must be true or false')
      return { id: id(i.id, 'checklist id'), text: str(i.text, 'checklist text', 1000), done: i.done }
    }),
    // Apps from before interface specs existed leave it out; the database then keeps what it has.
    ...(c.spec === undefined ? {} : { spec: spec(c.spec) }),
    // Apps from before progress existed leave both out; the database then keeps what it has.
    ...(c.progress === undefined
      ? {}
      : {
          progress: percent(c.progress, 'progress'),
          progress_log: arr(c.progress_log ?? [], 'progress_log', 1000).map(progressEntry),
        }),
    created_at: int(c.created_at, 'created_at'),
    updated_at: int(c.updated_at, 'updated_at'),
  }
}

function progressEntry(value: unknown): ProgressEntry {
  const e = obj(value, 'progress entry')
  return {
    id: id(e.id, 'progress entry id'),
    text: str(e.text, 'progress text', 5000),
    progress: percent(e.progress, 'progress'),
    at: int(e.at, 'progress at'),
  }
}

export function boardOps(value: unknown, boardId: string): BoardOps {
  const o = obj(value, 'changes')
  const board = o.board === undefined ? undefined : obj(o.board, 'board')
  return {
    board: board && {
      title: str(board.title, 'title'),
      labels: labels(board.labels),
      ...(board.team === undefined ? {} : { team: team(board.team) }),
    },
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
  /** When work starts. */
  startDate?: string | null
  /** When it is due: the end date. */
  dueDate?: string | null
  /** Estimated effort in man-days. */
  estimateDays?: number | null
  /** Label ids or names; unknown names become new labels. */
  labels?: string[]
  checklist?: { text: string; done: boolean }[]
  /** 0-100, or null to stop tracking. */
  progress?: number | null
  /** Team member ids or names; unknown names join the board's team. Replaces the assignees. */
  assignees?: string[]
  /** Fields of the card's interface spec to change (the card gets one if it has none), or null to remove it. */
  spec?: Partial<InterfaceSpec> | null
}

export interface TeamMemberInput {
  name?: string
  color?: string
  capacity?: number
}

export interface ProgressNoteInput {
  text: string
  /** Also sets the card's progress. */
  progress?: number | null
}

export interface CardQuery {
  boardId?: string
  column?: string
  label?: string
  priority?: CardRow['priority']
  search?: string
  dueFrom?: string
  dueTo?: string
  /** Team member id or name, or "none" for cards nobody is assigned to. */
  assignee?: string
  /** Only cards that are interfaces to implement (they have a spec). */
  interfaces?: boolean
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
  const s = str(value, 'color', 50)
  if (!/^#[0-9a-f]{6}$/i.test(s)) throw new BadRequest('color must look like #0090ff')
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
    startDate: optional(c.startDate, (v) => (v === null || v === '' ? null : date(v, 'startDate'))),
    dueDate: optional(c.dueDate, (v) => (v === null || v === '' ? null : date(v, 'dueDate'))),
    estimateDays: optional(c.estimateDays, (v) => estimate(v, 'estimateDays')),
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
    progress: optional(c.progress, (v) => percent(v, 'progress')),
    assignees: optional(c.assignees, (v) => arr(v, 'assignees', 200).map((a) => title(a, 'assignee', 100))),
    spec: optional(c.spec, (v) => (v === null ? null : specPatch(v, 'spec'))),
  }
}

export function teamMemberInput(value: unknown): TeamMemberInput {
  const m = obj(value, 'team member')
  const capacity = optional(m.capacity, (v) => wholeAtLeastZero(v, 'capacity'))
  if (capacity !== undefined && capacity > 999) throw new BadRequest('capacity must be from 0 to 999')
  return {
    name: optional(m.name, (v) => title(v, 'name', 100)),
    color: optional(m.color, color),
    capacity,
  }
}

export function progressNoteInput(value: unknown): ProgressNoteInput {
  const n = obj(value, 'progress update')
  const text = optional(n.text, (v) => str(v, 'text', 5000).trim()) ?? ''
  const progress = optional(n.progress, (v) => percent(v, 'progress'))
  if (!text && (progress === undefined || progress === null))
    throw new BadRequest('Give the update text, a progress from 0 to 100, or both')
  return { text, progress }
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
    assignee: optional(q.assignee, (v) => text(v, 'assignee')),
    interfaces: optional(q.interfaces, (v) => {
      if (v === true || v === 'true') return true
      if (v === false || v === 'false' || v === '') return undefined
      throw new BadRequest('interfaces must be true or false')
    }),
    limit: Math.min(Math.max(limit ?? 100, 1), 500),
  }
}

export function apiKeyName(value: unknown): string {
  return title(value, 'name', 100)
}

/** A board, card or column reference in MCP tool arguments. */
export function ref(value: unknown, what: string): string {
  return id(value, what)
}

// --- OAuth dynamic client registration (RFC 7591), server/src/oauth.ts ---

export interface OAuthClientRegistration {
  name: string
  redirectUris: string[]
  authMethod: 'none' | 'client_secret_post' | 'client_secret_basic'
}

/** Thrown for a bad registration; becomes {"error": "invalid_client_metadata"} or "invalid_redirect_uri". */
export class BadClientMetadata extends BadRequest {
  code: 'invalid_client_metadata' | 'invalid_redirect_uri'
  constructor(code: BadClientMetadata['code'], message: string) {
    super(message)
    this.code = code
  }
}

function redirectUri(value: unknown): string {
  const s = typeof value === 'string' && value.length <= 2000 ? value : ''
  let url: URL
  try {
    url = new URL(s)
  } catch {
    throw new BadClientMetadata('invalid_redirect_uri', 'redirect_uris must be absolute URLs')
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && local)))
    throw new BadClientMetadata('invalid_redirect_uri', 'redirect_uris must use https (or http on localhost)')
  return s
}

export function oauthClientRegistration(value: unknown): OAuthClientRegistration {
  const r = obj(value, 'client metadata')
  const uris = r.redirect_uris
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10)
    throw new BadClientMetadata('invalid_redirect_uri', 'redirect_uris must list 1 to 10 URLs')
  const subset = (list: unknown, allowed: string[], what: string) => {
    if (list === undefined) return
    if (!Array.isArray(list) || list.some((x) => !allowed.includes(x as string)))
      throw new BadClientMetadata('invalid_client_metadata', `${what} may only include ${allowed.join(', ')}`)
  }
  subset(r.grant_types, ['authorization_code', 'refresh_token'], 'grant_types')
  subset(r.response_types, ['code'], 'response_types')
  const method = r.token_endpoint_auth_method ?? 'client_secret_basic'
  if (method !== 'none' && method !== 'client_secret_post' && method !== 'client_secret_basic')
    throw new BadClientMetadata('invalid_client_metadata', 'Unsupported token_endpoint_auth_method')
  const name = typeof r.client_name === 'string' ? r.client_name.trim().slice(0, 100) : ''
  return { name: name || 'An app', redirectUris: uris.map(redirectUri), authMethod: method }
}

// --- Contacts and credentials (server/src/people.ts) ---

const plain = (value: unknown, what: string, max: number) => (value === undefined ? '' : str(value, what, max).trim())

export function contactInput(value: unknown): ContactInput {
  const c = obj(value, 'contact')
  return {
    name: title(c.name, 'name', 200),
    company: plain(c.company, 'company', 200),
    jobTitle: plain(c.jobTitle, 'jobTitle', 200),
    email: plain(c.email, 'email', 320),
    phone: plain(c.phone, 'phone', 100),
    website: plain(c.website, 'website', 2000),
    address: plain(c.address, 'address', 1000),
    notes: plain(c.notes, 'notes', 10_000),
  }
}

const MAX_SECRET = 20_000

/** On an update, null secret values and null notes mean "keep what is saved". */
export function credentialInput(value: unknown, isNew: boolean): CredentialInput {
  const c = obj(value, 'credential')
  const kind = c.kind as CredentialKind
  if (!credentialKinds.includes(kind)) throw new BadRequest(`kind must be one of ${credentialKinds.join(', ')}`)
  const seen = new Set<string>()
  const fields = arr(c.fields ?? [], 'fields', 50).map((item): CredentialField => {
    const f = obj(item, 'field')
    const name = title(f.name, 'field name', 100)
    if (seen.has(name.toLowerCase())) throw new BadRequest(`Two fields are named “${name}”`)
    seen.add(name.toLowerCase())
    const secret = f.secret === true
    const multiline = f.multiline === true
    if (f.value === null || f.value === undefined) {
      if (!secret || isNew) throw new BadRequest(`Give a value for “${name}”`)
      return { name, value: null, secret, multiline }
    }
    return { name, value: str(f.value, name, MAX_SECRET), secret, multiline }
  })
  let notes: string | null
  if (c.notes === null) {
    if (isNew) throw new BadRequest('notes must be text')
    notes = null
  } else notes = plain(c.notes, 'notes', MAX_SECRET)
  return { name: title(c.name, 'name', 200), kind, url: plain(c.url, 'url', 2000), notes, fields }
}

export interface AttachmentInput {
  name: string
  /** Media type, worked out from the file name (never taken from the caller). */
  type: string
  data: Buffer
  category: AttachmentCategory
}

/** Which part of the spec a file is; leaving it out means "other". */
export function attachmentCategory(value: unknown): AttachmentCategory {
  if (value === undefined) return 'other'
  if (typeof value !== 'string' || !(attachmentCategories as readonly string[]).includes(value))
    throw new BadRequest(`category must be one of ${attachmentCategories.join(', ')}`)
  return value as AttachmentCategory
}

/** A change to a file: `{category}`. */
export function attachmentUpdate(value: unknown): AttachmentCategory {
  const a = obj(value, 'body')
  if (a.category === undefined) throw new BadRequest('category is required')
  return attachmentCategory(a.category)
}

/** A file to attach: `{name, data, category?}` with the contents as base64. */
export function attachmentInput(value: unknown): AttachmentInput {
  const a = obj(value, 'attachment')
  // No folders or control characters in a file name.
  const name = [...title(a.name, 'name', 255)].map((ch) => (ch < ' ' || ch === '/' || ch === '\\' ? '_' : ch)).join('')
  if (typeof a.data !== 'string' || !/^[A-Za-z0-9+/\r\n]*={0,2}\s*$/.test(a.data))
    throw new BadRequest('data must be the file contents as base64')
  const data = Buffer.from(a.data, 'base64')
  const problem = attachmentProblem(name, data.length)
  if (problem) throw new BadRequest(problem)
  return { name, type: attachmentTypes[extensionOf(name)], data, category: attachmentCategory(a.category) }
}
