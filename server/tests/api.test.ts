// @vitest-environment node
// Exercises the server API against an in-process Postgres (PGlite): accounts,
// sharing, roles, invites and live-update notifications.
import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import type { Db, Queryable } from '../src/db.ts'
import { EventHub, type ServerEvent } from '../src/events.ts'
import { migrate } from '../src/migrate.ts'
import { todayISO } from '../../src/lib/dates.ts'
import { dueFromEstimate } from '../../src/lib/schedule.ts'

function pgliteDb(pg: PGlite): Db {
  const query = async <T>(q: Pick<PGlite, 'query' | 'exec'>, sql: string, params?: unknown[]) => {
    if (params?.length) return { rows: (await q.query<T>(sql, params)).rows }
    const results = await q.exec(sql)
    return { rows: (results.at(-1)?.rows ?? []) as T[] }
  }
  return {
    query: (sql, params) => query(pg, sql, params),
    transaction: (run) => pg.transaction((tx) => run({ query: (sql, params) => query(tx, sql, params) } as Queryable)),
    listen: async (channel, onMessage) => {
      const unlisten = await pg.listen(channel, onMessage)
      return async () => unlisten()
    },
    close: () => pg.close(),
  }
}

let pg: PGlite
let db: Db
let events: EventHub
let app: ReturnType<typeof createApp>
let received: { userId: string; event: ServerEvent }[]

beforeAll(async () => {
  pg = new PGlite()
  db = pgliteDb(pg)
  await migrate(db)
  // Migrations are idempotent: a second run applies nothing.
  await migrate(db)
}, 30_000)

afterAll(() => db.close())

beforeEach(async () => {
  await pg.exec(
    'truncate kanban.users, kanban.sessions, kanban.boards, kanban.board_members, kanban.columns, kanban.cards, kanban.board_invites, kanban.oauth_clients, kanban.contacts, kanban.credentials cascade',
  )
  events = new EventHub(db)
  app = createApp({ db, events })
  received = []
})

/** A signed-in browser: keeps its session cookie between requests. */
async function signUp(email: string) {
  let cookie = ''
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie) cookie = setCookie.split(';')[0]
    // oxlint-disable-next-line no-explicit-any -- test responses are checked by assertions
    const data = (await res.json()) as any
    return { status: res.status, data }
  }
  const res = await call('POST', '/auth/signup', { email, password: 'correct horse' })
  expect(res.status).toBe(200)
  const user = res.data.user as { id: string; email: string }
  events.add({ userId: user.id, send: (event) => received.push({ userId: user.id, event }) })
  return { call, user }
}

const board = {
  board: { id: 'b1', title: 'Trip', labels: [{ id: 'l1', name: 'Booking', color: '#f00' }], created_at: 1 },
  columns: [
    { id: 'col1', position: 0, title: 'To do', wip_limit: 0 },
    { id: 'col2', position: 1, title: 'Done', wip_limit: 0 },
  ],
  cards: [
    {
      id: 'c1',
      column_id: 'col1',
      position: 0,
      title: 'Book flights',
      description: '',
      label_ids: ['l1'],
      priority: 'high',
      due_date: '2026-11-01',
      checklist: [{ id: 'i1', text: 'Compare prices', done: false }],
      created_at: 1,
      updated_at: 1,
    },
  ],
}

const card = (id: string, title: string, column_id = 'col1', position = 1) => ({
  ...board.cards[0],
  id,
  title,
  column_id,
  position,
})

async function ownerWithBoard() {
  const ana = await signUp('ana@example.com')
  expect((await ana.call('POST', '/boards', board)).status).toBe(200)
  return ana
}

async function share(owner: Awaited<ReturnType<typeof signUp>>, email: string, role: 'editor' | 'viewer') {
  const guest = await signUp(email)
  await owner.call('POST', '/boards/b1/invites', { email, role })
  const invites = (await guest.call('GET', '/invites')).data
  await guest.call('POST', `/invites/${invites[0].id}/accept`, {})
  return guest
}

describe('accounts', () => {
  it('signs up, signs in and out, and rejects bad passwords', async () => {
    const ana = await signUp('Ana@Example.com')
    expect((await ana.call('GET', '/auth/me')).data.user).toMatchObject({ email: 'ana@example.com' })
    await ana.call('POST', '/auth/signout', {})
    expect((await ana.call('GET', '/auth/me')).data.user).toBeNull()
    expect((await ana.call('GET', '/boards')).status).toBe(401)

    expect((await ana.call('POST', '/auth/signin', { email: 'ana@example.com', password: 'wrong pass' })).status).toBe(
      401,
    )
    expect(
      (await ana.call('POST', '/auth/signin', { email: 'ANA@example.com', password: 'correct horse' })).status,
    ).toBe(200)
    expect((await ana.call('GET', '/auth/me')).data.user).toMatchObject({ email: 'ana@example.com' })

    const again = await ana.call('POST', '/auth/signup', { email: 'ana@example.com', password: 'another one' })
    expect(again.status).toBe(409)
    const short = await ana.call('POST', '/auth/signup', { email: 'new@example.com', password: 'short' })
    expect(short.status).toBe(400)
  })

  it('stores only password and session hashes', async () => {
    await signUp('ana@example.com')
    const { rows } = await db.query<{ password_hash: string }>('select password_hash from kanban.users')
    expect(rows[0].password_hash).toMatch(/^scrypt\$/)
    expect(rows[0].password_hash).not.toContain('correct horse')
  })

  it('refuses requests that are not JSON', async () => {
    const res = await app.request('/api/auth/signout', { method: 'POST', body: 'x' })
    expect(res.status).toBe(400)
  })
})

describe('boards', () => {
  it('creates a board, reads it back and applies changes', async () => {
    const ana = await ownerWithBoard()
    expect((await ana.call('GET', '/boards')).data).toEqual([expect.objectContaining({ id: 'b1', role: 'owner' })])
    const doc = (await ana.call('GET', '/boards/b1')).data
    expect(doc.board).toEqual({ ...board.board, team: [] })
    expect(doc.cards).toEqual([expect.objectContaining({ ...board.cards[0], board_id: 'b1' })])

    const res = await ana.call('POST', '/boards/b1/changes', {
      board: { title: 'Trip to Japan', labels: [] },
      upsertCards: [card('c1', 'Book flights', 'col2', 0), card('c2', 'Pack')],
      deleteColumnIds: [],
      upsertColumns: [],
      deleteCardIds: [],
    })
    expect(res.status).toBe(200)
    const after = (await ana.call('GET', '/boards/b1')).data
    expect(after.board.title).toBe('Trip to Japan')
    expect((after.cards as { id: string; column_id: string }[]).map((c) => [c.id, c.column_id]).sort()).toEqual([
      ['c1', 'col2'],
      ['c2', 'col1'],
    ])

    await ana.call('POST', '/boards/b1/changes', { deleteColumnIds: ['col1'] })
    expect((await ana.call('GET', '/boards/b1')).data.cards).toHaveLength(1)
  })

  it('keeps boards private and ids from being hijacked', async () => {
    await ownerWithBoard()
    const eve = await signUp('eve@example.com')
    expect((await eve.call('GET', '/boards')).data).toEqual([])
    expect((await eve.call('GET', '/boards/b1')).status).toBe(404)
    expect((await eve.call('POST', '/boards/b1/changes', { upsertCards: [card('c1', 'hacked')] })).status).toBe(404)
    expect((await eve.call('DELETE', '/boards/b1')).status).toBe(404)
    expect((await eve.call('GET', '/boards/b1/members')).status).toBe(404)

    // Reusing someone else's board, column or card id doesn't touch their data.
    expect((await eve.call('POST', '/boards', board)).status).toBe(409)
    await eve.call('POST', '/boards', { ...board, board: { ...board.board, id: 'b2' }, columns: [], cards: [] })
    const res = await eve.call('POST', '/boards/b2/changes', {
      upsertColumns: [{ id: 'col1', position: 0, title: 'stolen', wip_limit: 0 }],
    })
    expect(res.status).toBe(409)
    const { rows } = await db.query<{ title: string; board_id: string }>(
      "select title, board_id from kanban.columns where id = 'col1'",
    )
    expect(rows).toEqual([{ title: 'To do', board_id: 'b1' }])
  })

  it('syncs card progress, and keeps it when an older app leaves it out', async () => {
    const ana = await ownerWithBoard()
    const entry = { id: 'p1', text: 'Shortlisted two airlines', progress: 40, at: 5 }
    await ana.call('POST', '/boards/b1/changes', {
      upsertCards: [{ ...card('c1', 'Book flights', 'col1', 0), progress: 40, progress_log: [entry] }],
    })
    const stored = () => ana.call('GET', '/boards/b1').then((r) => r.data.cards[0])
    expect(await stored()).toMatchObject({ progress: 40, progress_log: [entry] })

    await ana.call('POST', '/boards/b1/changes', { upsertCards: [card('c1', 'Book cheap flights', 'col1', 0)] })
    expect(await stored()).toMatchObject({ title: 'Book cheap flights', progress: 40, progress_log: [entry] })

    await ana.call('POST', '/boards/b1/changes', {
      upsertCards: [{ ...card('c1', 'Book cheap flights', 'col1', 0), progress: null, progress_log: [] }],
    })
    expect(await stored()).toMatchObject({ progress: null, progress_log: [] })

    const bad = await ana.call('POST', '/boards/b1/changes', { upsertCards: [{ ...card('c1', 'x'), progress: 120 }] })
    expect(bad.status).toBe(400)
    expect(bad.data.error).toMatch(/progress/)
  })

  it('syncs card start dates, and keeps them when an older app leaves them out', async () => {
    const ana = await ownerWithBoard()
    await ana.call('POST', '/boards/b1/changes', {
      upsertCards: [{ ...card('c1', 'Book flights', 'col1', 0), start_date: '2026-10-25' }],
    })
    const stored = () => ana.call('GET', '/boards/b1').then((r) => r.data.cards[0])
    expect(await stored()).toMatchObject({ start_date: '2026-10-25', due_date: '2026-11-01' })

    await ana.call('POST', '/boards/b1/changes', { upsertCards: [card('c1', 'Book cheap flights', 'col1', 0)] })
    expect(await stored()).toMatchObject({ title: 'Book cheap flights', start_date: '2026-10-25' })

    await ana.call('POST', '/boards/b1/changes', { upsertCards: [{ ...card('c1', 'x', 'col1', 0), start_date: null }] })
    expect((await stored()).start_date).toBeNull()

    const viewer = await share(ana, 'ben@example.com', 'viewer')
    const refused = await viewer.call('POST', '/boards/b1/changes', {
      upsertCards: [{ ...card('c1', 'x', 'col1', 0), start_date: '2026-10-01' }],
    })
    expect(refused.status).toBe(403)
  })

  it('syncs card estimates, and keeps them when an older app leaves them out', async () => {
    const ana = await ownerWithBoard()
    await ana.call('POST', '/boards/b1/changes', {
      upsertCards: [{ ...card('c1', 'Book flights', 'col1', 0), estimate_days: 2.5 }],
    })
    const stored = () => ana.call('GET', '/boards/b1').then((r) => r.data.cards[0])
    expect((await stored()).estimate_days).toBe(2.5)
    await ana.call('POST', '/boards/b1/changes', { upsertCards: [card('c1', 'Book cheap flights', 'col1', 0)] })
    expect(await stored()).toMatchObject({ title: 'Book cheap flights', estimate_days: 2.5 })
    const bad = await ana.call('POST', '/boards/b1/changes', { upsertCards: [{ ...card('c1', 'x'), estimate_days: -1 }] })
    expect(bad.status).toBe(400)
    const viewer = await share(ana, 'ben@example.com', 'viewer')
    const refused = await viewer.call('POST', '/boards/b1/changes', {
      upsertCards: [{ ...card('c1', 'x', 'col1', 0), estimate_days: 1 }],
    })
    expect(refused.status).toBe(403)
  })

  it('syncs the team and card assignees, and keeps them when an older app leaves them out', async () => {
    const ana = await ownerWithBoard()
    const team = [{ id: 'm1', name: 'Kim', color: '#0090ff', capacity: 2 }]
    await ana.call('POST', '/boards/b1/changes', {
      board: { title: 'Trip', labels: board.board.labels, team },
      upsertCards: [{ ...card('c1', 'Book flights', 'col1', 0), assignee_ids: ['m1'] }],
    })
    const stored = () => ana.call('GET', '/boards/b1').then((r) => r.data)
    expect((await stored()).board.team).toEqual(team)
    expect((await stored()).cards[0].assignee_ids).toEqual(['m1'])

    // An app from before teams sends neither; both stay.
    await ana.call('POST', '/boards/b1/changes', {
      board: { title: 'Trip!', labels: [] },
      upsertCards: [card('c1', 'Book cheap flights', 'col1', 0)],
    })
    const after = await stored()
    expect(after.board).toMatchObject({ title: 'Trip!', team })
    expect(after.cards[0]).toMatchObject({ title: 'Book cheap flights', assignee_ids: ['m1'] })

    const bad = await ana.call('POST', '/boards/b1/changes', {
      board: { title: 'Trip', labels: [], team: [{ ...team[0], capacity: -1 }] },
    })
    expect(bad.status).toBe(400)
    expect(bad.data.error).toMatch(/capacity/)
  })

  it('rejects malformed changes', async () => {
    const ana = await ownerWithBoard()
    const bad = await ana.call('POST', '/boards/b1/changes', {
      upsertCards: [{ ...card('c3', 'x'), priority: 'mega' }],
    })
    expect(bad.status).toBe(400)
    expect(bad.data.error).toMatch(/priority/)
  })
})

describe('sharing', () => {
  it('invites by email: the invitee sees it, accepts, and can edit', async () => {
    const ana = await ownerWithBoard()
    const ben = await signUp('ben@example.com')
    await ana.call('POST', '/boards/b1/invites', { email: 'BEN@example.com', role: 'editor' })
    expect((await ana.call('POST', '/boards/b1/invites', { email: 'ben@example.com', role: 'viewer' })).status).toBe(
      409,
    )

    const invites = (await ben.call('GET', '/invites')).data
    expect(invites).toEqual([
      expect.objectContaining({ boardId: 'b1', boardTitle: 'Trip', role: 'editor', invitedBy: 'ana@example.com' }),
    ])
    const cat = await signUp('cat@example.com')
    expect((await cat.call('POST', `/invites/${invites[0].id}/accept`, {})).status).toBe(404)

    expect((await ben.call('POST', `/invites/${invites[0].id}/accept`, {})).data).toEqual({ boardId: 'b1' })
    expect((await ben.call('POST', '/boards/b1/changes', { upsertCards: [card('c2', 'From Ben')] })).status).toBe(200)
    expect((await ben.call('GET', '/boards/b1/members')).data).toEqual([
      expect.objectContaining({ email: 'ana@example.com', role: 'owner' }),
      expect.objectContaining({ email: 'ben@example.com', role: 'editor' }),
    ])
    // Editors can't invite or delete the board.
    expect((await ben.call('POST', '/boards/b1/invites', { email: 'x@example.com', role: 'editor' })).status).toBe(403)
    expect((await ben.call('DELETE', '/boards/b1')).status).toBe(403)
  })

  it('lets the invitee decline', async () => {
    const ana = await ownerWithBoard()
    const ben = await signUp('ben@example.com')
    await ana.call('POST', '/boards/b1/invites', { email: 'ben@example.com', role: 'editor' })
    const [invite] = (await ben.call('GET', '/invites')).data
    await ben.call('POST', `/invites/${invite.id}/decline`, {})
    expect((await ana.call('GET', '/boards/b1/invites')).data).toEqual([])
    expect((await ben.call('GET', '/boards')).data).toEqual([])
  })

  it('joins with a link, keeps viewers read-only, and stops working once turned off', async () => {
    const ana = await ownerWithBoard()
    const { token } = (await ana.call('POST', '/boards/b1/invites', { link: true, role: 'viewer' })).data
    const cat = await signUp('cat@example.com')
    expect((await cat.call('POST', '/join', { token })).data).toEqual({ boardId: 'b1' })
    expect((await cat.call('GET', '/boards/b1')).status).toBe(200)
    expect((await cat.call('POST', '/boards/b1/changes', { upsertCards: [card('c2', 'nope')] })).status).toBe(403)

    const [link] = (await ana.call('GET', '/boards/b1/invites')).data
    await ana.call('DELETE', `/invites/${link.id}`)
    const dan = await signUp('dan@example.com')
    expect((await dan.call('POST', '/join', { token })).status).toBe(404)
  })

  it('lets the owner change roles and remove people, and members leave', async () => {
    const ana = await ownerWithBoard()
    const ben = await share(ana, 'ben@example.com', 'viewer')
    const cat = await share(ana, 'cat@example.com', 'editor')

    await ana.call('PATCH', `/boards/b1/members/${ben.user.id}`, { role: 'editor' })
    expect((await ben.call('GET', '/boards')).data[0].role).toBe('editor')
    expect((await ana.call('PATCH', `/boards/b1/members/${ana.user.id}`, { role: 'viewer' })).status).toBe(404)
    expect((await ben.call('PATCH', `/boards/b1/members/${cat.user.id}`, { role: 'viewer' })).status).toBe(403)
    expect((await ben.call('DELETE', `/boards/b1/members/${cat.user.id}`)).status).toBe(403)

    await ana.call('DELETE', `/boards/b1/members/${ben.user.id}`)
    expect((await ben.call('GET', '/boards/b1')).status).toBe(404)
    await cat.call('DELETE', `/boards/b1/members/${cat.user.id}`)
    expect((await cat.call('GET', '/boards')).data).toEqual([])
    expect((await ana.call('DELETE', `/boards/b1/members/${ana.user.id}`)).status).toBe(400)
  })

  it('deletes the board for everyone', async () => {
    const ana = await ownerWithBoard()
    const ben = await share(ana, 'ben@example.com', 'editor')
    expect((await ana.call('DELETE', '/boards/b1')).status).toBe(200)
    expect((await ben.call('GET', '/boards')).data).toEqual([])
    expect((await db.query('select * from kanban.cards')).rows).toEqual([])
  })
})

describe('live updates', () => {
  it('tells members when a board changes and people when their access changes', async () => {
    const ana = await ownerWithBoard()
    const ben = await share(ana, 'ben@example.com', 'editor')
    const eve = await signUp('eve@example.com')
    const stop = await events.start()
    received = []

    await ben.call('POST', '/boards/b1/changes', { upsertCards: [card('c2', 'From Ben')] })
    await ana.call('PATCH', `/boards/b1/members/${ben.user.id}`, { role: 'viewer' })
    await new Promise((r) => setTimeout(r, 50))
    await stop()

    const to = (userId: string) => received.filter((r) => r.userId === userId).map((r) => r.event.type)
    expect(to(ana.user.id)).toContain('board')
    expect(to(ben.user.id)).toEqual(expect.arrayContaining(['board', 'member']))
    expect(to(eve.user.id)).toEqual([])
  })
})

/** An automation tool (n8n) calling with an API key, in an X-API-Key header unless `bearer` is set. */
async function apiKeyFor(person: Awaited<ReturnType<typeof signUp>>, name = 'n8n', bearer = false) {
  const res = await person.call('POST', '/api-keys', { name })
  expect(res.status).toBe(200)
  const key = res.data.key as string
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: {
        ...(bearer ? { authorization: `Bearer ${key}` } : { 'x-api-key': key }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    // oxlint-disable-next-line no-explicit-any -- test responses are checked by assertions
    const data = res.status === 202 ? null : ((await res.json()) as any)
    return { status: res.status, data, headers: res.headers }
  }
  return { key, id: res.data.id as string, call }
}

describe('API keys', () => {
  it('creates a key shown once, signs in with it, and stops working once revoked', async () => {
    const ana = await signUp('ana@example.com')
    const n8n = await apiKeyFor(ana)
    expect(n8n.key).toMatch(/^kbn_/)
    expect((await n8n.call('GET', '/v1/me')).data).toEqual(ana.user)
    expect((await n8n.call('GET', '/auth/me')).data.user).toEqual(ana.user)

    const listed = (await ana.call('GET', '/api-keys')).data
    expect(listed).toEqual([expect.objectContaining({ id: n8n.id, name: 'n8n', lastUsedAt: expect.any(String) })])
    expect(JSON.stringify(listed)).not.toContain(n8n.key)
    const { rows } = await db.query<{ token_hash: string }>('select token_hash from kanban.api_keys')
    expect(rows[0].token_hash).not.toContain(n8n.key)

    expect((await ana.call('DELETE', `/api-keys/${n8n.id}`)).status).toBe(200)
    const after = await n8n.call('GET', '/v1/boards')
    expect(after.status).toBe(401)
    expect(after.data.error).toBe('Unknown or revoked API key')
  })

  it('also accepts the key as a Bearer token', async () => {
    const ana = await signUp('ana@example.com')
    const n8n = await apiKeyFor(ana, 'n8n', true)
    expect((await n8n.call('GET', '/v1/me')).data).toEqual(ana.user)
    expect((await n8n.call('DELETE', '/v1/cards/nope')).status).toBe(404)
  })

  it('refuses unknown keys, other people’s keys, and keys managing keys', async () => {
    const ana = await signUp('ana@example.com')
    const eve = await signUp('eve@example.com')
    const n8n = await apiKeyFor(ana)
    expect((await n8n.call('GET', '/api-keys')).status).toBe(403)
    expect((await n8n.call('POST', '/api-keys', { name: 'more' })).status).toBe(403)
    expect((await n8n.call('DELETE', `/api-keys/${n8n.id}`)).status).toBe(403)
    // Eve can't revoke Ana's key.
    await eve.call('DELETE', `/api-keys/${n8n.id}`)
    expect((await n8n.call('GET', '/v1/me')).status).toBe(200)
    expect((await eve.call('POST', '/api-keys', { name: '' })).status).toBe(400)

    const badKeys: Record<string, string>[] = [
      { 'x-api-key': 'kbn_nope' },
      { 'x-api-key': '' },
      { 'x-api-key': 'not-a-key' },
      { authorization: 'Bearer kbn_nope' },
      { authorization: 'Bearer' },
    ]
    for (const headers of badKeys) {
      const res = await app.request('/api/v1/boards', { headers })
      expect(res.status).toBe(401)
    }
    // A bad key isn't rescued by a session cookie that came along.
    const res = await app.request('/api/v1/boards', { headers: { 'x-api-key': 'kbn_nope', cookie: 'x=y' } })
    expect(res.status).toBe(401)
  })

  it('needs a signed-in session to manage keys', async () => {
    const res = await app.request('/api/api-keys')
    expect(res.status).toBe(401)
  })
})

describe('REST API (v1)', () => {
  it('serves its OpenAPI description without a key', async () => {
    const res = await app.request('/api/v1/openapi.json')
    expect(res.status).toBe(200)
    const spec = (await res.json()) as { openapi: string; paths: Record<string, unknown> }
    expect(spec.openapi).toBe('3.0.3')
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/boards', '/boards/{boardId}/cards', '/cards/{cardId}']))
  })

  it('creates a board and manages its columns', async () => {
    const n8n = await apiKeyFor(await signUp('ana@example.com'))
    const created = await n8n.call('POST', '/v1/boards', { title: 'Inbox', labels: [{ name: 'Email' }] })
    expect(created.status).toBe(201)
    const b = created.data
    expect(b).toMatchObject({ title: 'Inbox', role: 'owner', labels: [{ name: 'Email', color: '#e5484d' }] })
    expect(b.columns.map((c: { title: string }) => c.title)).toEqual(['To do', 'In progress', 'Done'])
    expect((await n8n.call('GET', '/v1/boards')).data).toEqual([
      expect.objectContaining({ id: b.id, title: 'Inbox', role: 'owner', cardCount: 0 }),
    ])

    const col = await n8n.call('POST', `/v1/boards/${b.id}/columns`, { title: 'Waiting', position: 1, wipLimit: 3 })
    expect(col.status).toBe(201)
    expect(col.data).toMatchObject({ title: 'Waiting', wipLimit: 3, position: 1 })
    await n8n.call('PATCH', `/v1/boards/${b.id}/columns/done`, { title: 'Finished', position: 0 })
    expect((await n8n.call('PATCH', `/v1/boards/${b.id}`, { title: 'Email inbox' })).data.title).toBe('Email inbox')
    await n8n.call('DELETE', `/v1/boards/${b.id}/columns/In%20progress`)
    const after = (await n8n.call('GET', `/v1/boards/${b.id}`)).data
    expect(after.columns.map((c: { title: string; position: number }) => [c.title, c.position])).toEqual([
      ['Finished', 0],
      ['To do', 1],
      ['Waiting', 2],
    ])
    expect((await n8n.call('PATCH', `/v1/boards/${b.id}/columns/Nope`, { title: 'x' })).status).toBe(404)
    expect((await n8n.call('POST', `/v1/boards/${b.id}/columns`, { title: '' })).status).toBe(400)

    // The app sees the board as an ordinary account board.
    const { rows } = await db.query<{ position: number; title: string }>(
      'select position, title from kanban.columns where board_id = $1 order by position',
      [b.id],
    )
    expect(rows.map((r) => r.title)).toEqual(['Finished', 'To do', 'Waiting'])

    expect((await n8n.call('DELETE', `/v1/boards/${b.id}`)).status).toBe(200)
    expect((await n8n.call('GET', '/v1/boards')).data).toEqual([])
  })

  it('creates, finds, updates, moves and deletes cards', async () => {
    const ana = await ownerWithBoard()
    const n8n = await apiKeyFor(ana)
    const created = await n8n.call('POST', '/v1/boards/b1/cards', {
      column: 'to do',
      title: 'Renew passport',
      description: 'Before the trip',
      priority: 'urgent',
      dueDate: '2026-10-20',
      labels: ['booking', 'Paperwork'],
      checklist: ['Photos', { text: 'Form', done: true }],
      position: 0,
    })
    expect(created.status).toBe(201)
    const card = created.data
    expect(card).toMatchObject({
      boardId: 'b1',
      columnId: 'col1',
      column: 'To do',
      position: 0,
      priority: 'urgent',
      dueDate: '2026-10-20',
      labels: [
        { id: 'l1', name: 'Booking' },
        { name: 'Paperwork', color: expect.stringMatching(/^#/) },
      ],
      checklist: [
        { text: 'Photos', done: false },
        { text: 'Form', done: true },
      ],
    })
    // The existing card moved down one place to make room.
    const col1 = (await n8n.call('GET', '/v1/boards/b1')).data.columns[0]
    expect(col1.cards.map((c: { title: string }) => c.title)).toEqual(['Renew passport', 'Book flights'])
    expect((await n8n.call('GET', '/v1/boards/b1')).data.labels.map((l: { name: string }) => l.name)).toEqual([
      'Booking',
      'Paperwork',
    ])

    const find = async (query: string) =>
      (await n8n.call('GET', `/v1/cards?${query}`)).data.map((c: { title: string }) => c.title)
    expect(await find('label=paperwork')).toEqual(['Renew passport'])
    expect(await find('search=trip')).toEqual(['Renew passport'])
    expect(await find('search=prices')).toEqual(['Book flights'])
    expect(await find('dueTo=2026-10-31')).toEqual(['Renew passport'])
    expect(await find('dueFrom=2026-10-21&priority=high')).toEqual(['Book flights'])
    expect(await find('search=100%25')).toEqual([])
    expect(await find('limit=1')).toHaveLength(1)
    expect((await n8n.call('GET', '/v1/boards/b1/cards?column=Done')).data).toEqual([])
    expect((await n8n.call('GET', '/v1/cards?dueTo=tomorrow')).status).toBe(400)

    const moved = await n8n.call('PATCH', `/v1/cards/${card.id}`, {
      column: 'Done',
      title: 'Passport renewed',
      dueDate: null,
      checklist: [{ text: 'Photos', done: true }],
    })
    expect(moved.data).toMatchObject({ column: 'Done', position: 0, title: 'Passport renewed', dueDate: null })
    expect(moved.data.checklist).toEqual([{ id: card.checklist[0].id, text: 'Photos', done: true }])
    expect(moved.data.labels).toHaveLength(2)
    expect((await n8n.call('GET', '/v1/cards/c1')).data).toMatchObject({ column: 'To do', position: 0 })

    expect((await n8n.call('DELETE', `/v1/cards/${card.id}`)).status).toBe(200)
    expect((await n8n.call('GET', `/v1/cards/${card.id}`)).status).toBe(404)
    expect((await n8n.call('POST', '/v1/boards/b1/cards', { column: 'Nope', title: 'x' })).status).toBe(404)
    expect((await n8n.call('POST', '/v1/boards/b1/cards', { column: 'To do', priority: 'mega' })).status).toBe(400)
  })

  it('sets card progress and logs progress updates', async () => {
    const ana = await ownerWithBoard()
    const n8n = await apiKeyFor(ana)
    expect((await n8n.call('GET', '/v1/cards/c1')).data).toMatchObject({ progress: null, progressLog: [] })
    expect((await n8n.call('PATCH', '/v1/cards/c1', { progress: 25 })).data.progress).toBe(25)

    const logged = await n8n.call('POST', '/v1/cards/c1/progress', { text: 'Picked the dates', progress: 60 })
    expect(logged.status).toBe(201)
    expect(logged.data).toMatchObject({
      progress: 60,
      progressLog: [{ id: expect.any(String), text: 'Picked the dates', progress: 60, at: expect.any(String) }],
    })
    // A note on its own keeps the progress; a later note goes after the earlier one.
    const note = await n8n.call('POST', '/v1/cards/c1/progress', { text: 'Waiting on visa' })
    expect(note.data.progress).toBe(60)
    expect(note.data.progressLog.map((e: { text: string }) => e.text)).toEqual(['Picked the dates', 'Waiting on visa'])
    expect((await n8n.call('GET', '/v1/cards?search=visa')).data).toHaveLength(1)

    expect((await n8n.call('POST', '/v1/cards/c1/progress', {})).status).toBe(400)
    expect((await n8n.call('POST', '/v1/cards/c1/progress', { progress: 101 })).status).toBe(400)
    expect((await n8n.call('PATCH', '/v1/cards/c1', { progress: -1 })).status).toBe(400)
    expect((await n8n.call('PATCH', '/v1/cards/c1', { progress: null })).data.progress).toBeNull()

    const viewer = await apiKeyFor(await share(ana, 'ben@example.com', 'viewer'))
    expect((await viewer.call('POST', '/v1/cards/c1/progress', { text: 'x' })).status).toBe(403)
    expect((await viewer.call('PATCH', '/v1/cards/c1', { progress: 90 })).status).toBe(403)
    const stranger = await apiKeyFor(await signUp('eve@example.com'))
    expect((await stranger.call('POST', '/v1/cards/c1/progress', { text: 'x' })).status).toBe(404)
  })

  it('needs a start and end date on R4C and Project cards', async () => {
    const ana = await ownerWithBoard()
    const n8n = await apiKeyFor(ana)
    const add = (body: object) => n8n.call('POST', '/v1/boards/b1/cards', { column: 'To do', title: 'Rollout', ...body })

    const missing = await add({ labels: ['R4C'] })
    expect(missing.status).toBe(400)
    expect(missing.data.error).toMatch(/R4C cards need a start date and an end date/)
    expect((await add({ labels: ['project'], startDate: '2026-11-01' })).data.error).toMatch(/need an end date/)
    expect((await add({ labels: ['Project'], dueDate: '2026-11-30' })).data.error).toMatch(/need a start date/)
    expect((await add({ startDate: '2026-12-01', dueDate: '2026-11-30' })).data.error).toMatch(/start date is after/)
    expect((await add({ startDate: 'soon' })).status).toBe(400)

    const created = await add({ labels: ['R4C', 'Project'], startDate: '2026-11-01', dueDate: '2026-11-30' })
    expect(created.status).toBe(201)
    expect(created.data).toMatchObject({ startDate: '2026-11-01', dueDate: '2026-11-30' })
    const id = created.data.id

    // Clearing either date, or moving the end before the start, is refused.
    expect((await n8n.call('PATCH', `/v1/cards/${id}`, { startDate: null })).status).toBe(400)
    expect((await n8n.call('PATCH', `/v1/cards/${id}`, { dueDate: '2026-10-01' })).status).toBe(400)
    const moved = await n8n.call('PATCH', `/v1/cards/${id}`, { startDate: '2026-11-03', dueDate: '2026-12-05' })
    expect(moved.data).toMatchObject({ startDate: '2026-11-03', dueDate: '2026-12-05' })
    // Taking the label off lets the dates go.
    const plain = await n8n.call('PATCH', `/v1/cards/${id}`, { labels: [], startDate: null })
    expect(plain.data).toMatchObject({ labels: [], startDate: null, dueDate: '2026-12-05' })

    // Adding the label to a card without dates is refused; older cards can still be renamed and moved.
    expect((await n8n.call('PATCH', '/v1/cards/c1', { labels: ['R4C'] })).status).toBe(400)
    await db.query(`update kanban.cards set label_ids = '["l1","lp"]'::jsonb, due_date = null where id = 'c1'`)
    await db.query(
      `update kanban.boards set labels = labels || '[{"id":"lp","name":"Project","color":"#f76b15"}]'::jsonb where id = 'b1'`,
    )
    expect((await n8n.call('PATCH', '/v1/cards/c1', { title: 'Book flights soon', column: 'Done' })).status).toBe(200)

    const viewer = await apiKeyFor(await share(ana, 'ben@example.com', 'viewer'))
    expect((await viewer.call('PATCH', `/v1/cards/${id}`, { startDate: '2026-11-04' })).status).toBe(403)
  })

  it('starts cards that move into progress and works out their due date from the estimate', async () => {
    const ana = await ownerWithBoard()
    const n8n = await apiKeyFor(ana)
    await n8n.call('POST', '/v1/boards/b1/columns', { title: 'In progress', position: 1 })
    const today = todayISO()

    const fix = (await n8n.call('POST', '/v1/boards/b1/cards', { column: 'To do', title: 'Fix import', estimateDays: 3 })).data
    expect(fix).toMatchObject({ estimateDays: 3, startDate: null, dueDate: null })
    const started = await n8n.call('PATCH', `/v1/cards/${fix.id}`, { column: 'In progress' })
    expect(started.data).toMatchObject({ startDate: today, dueDate: dueFromEstimate(today, 3) })
    // A new estimate moves the due date; a given due date wins.
    expect((await n8n.call('PATCH', `/v1/cards/${fix.id}`, { estimateDays: 1 })).data.dueDate).toBe(
      dueFromEstimate(today, 1),
    )
    expect((await n8n.call('PATCH', `/v1/cards/${fix.id}`, { dueDate: '2030-01-01' })).data.dueDate).toBe('2030-01-01')
    // Moving out and back keeps the first start date.
    await n8n.call('PATCH', `/v1/cards/${fix.id}`, { column: 'To do' })
    const back = await n8n.call('PATCH', `/v1/cards/${fix.id}`, { column: 'In progress', estimateDays: 2 })
    expect(back.data).toMatchObject({ startDate: today, dueDate: dueFromEstimate(today, 2) })

    // Created straight into progress.
    const quick = await n8n.call('POST', '/v1/boards/b1/cards', { column: 'In progress', title: 'Quick fix', estimateDays: 0.5 })
    expect(quick.data).toMatchObject({ startDate: today, dueDate: dueFromEstimate(today, 0.5) })

    // R4C cards keep their own dates.
    const r4c = await n8n.call('POST', '/v1/boards/b1/cards', {
      column: 'To do',
      title: 'Onboard partner',
      labels: ['R4C'],
      startDate: '2030-02-01',
      dueDate: '2030-03-01',
      estimateDays: 5,
    })
    const moved = await n8n.call('PATCH', `/v1/cards/${r4c.data.id}`, { column: 'In progress' })
    expect(moved.data).toMatchObject({ startDate: '2030-02-01', dueDate: '2030-03-01' })

    expect((await n8n.call('PATCH', `/v1/cards/${fix.id}`, { estimateDays: 0 })).status).toBe(400)
    expect((await n8n.call('PATCH', `/v1/cards/${fix.id}`, { estimateDays: '3' })).status).toBe(400)
    const viewer = await apiKeyFor(await share(ana, 'ben@example.com', 'viewer'))
    expect((await viewer.call('PATCH', `/v1/cards/${fix.id}`, { estimateDays: 4 })).status).toBe(403)
  })

  it('gives API keys their owner’s role on each board', async () => {
    const ana = await ownerWithBoard()
    const viewer = await apiKeyFor(await share(ana, 'ben@example.com', 'viewer'))
    const editor = await apiKeyFor(await share(ana, 'cat@example.com', 'editor'))
    const stranger = await apiKeyFor(await signUp('eve@example.com'))

    expect((await viewer.call('GET', '/v1/boards/b1')).data.role).toBe('viewer')
    expect((await viewer.call('GET', '/v1/cards/c1')).status).toBe(200)
    expect((await viewer.call('POST', '/v1/boards/b1/cards', { column: 'To do', title: 'x' })).status).toBe(403)
    expect((await viewer.call('PATCH', '/v1/cards/c1', { title: 'x' })).status).toBe(403)
    expect((await viewer.call('DELETE', '/v1/cards/c1')).status).toBe(403)
    expect((await viewer.call('POST', '/v1/boards/b1/columns', { title: 'x' })).status).toBe(403)
    expect((await viewer.call('PATCH', '/v1/boards/b1', { title: 'x' })).status).toBe(403)

    expect((await editor.call('PATCH', '/v1/cards/c1', { priority: 'low' })).status).toBe(200)
    expect((await editor.call('DELETE', '/v1/boards/b1/columns/Done')).status).toBe(200)
    expect((await editor.call('DELETE', '/v1/boards/b1')).status).toBe(403)

    expect((await stranger.call('GET', '/v1/boards/b1')).status).toBe(404)
    expect((await stranger.call('GET', '/v1/cards/c1')).status).toBe(404)
    expect((await stranger.call('PATCH', '/v1/cards/c1', { title: 'hacked' })).status).toBe(404)
    expect((await stranger.call('DELETE', '/v1/cards/c1')).status).toBe(404)
    expect((await stranger.call('GET', '/v1/cards')).data).toEqual([])
  })

  it('assigns cards to the team, manages the team and reports workload', async () => {
    const ana = await ownerWithBoard()
    const n8n = await apiKeyFor(ana)
    // Assigning by a new name adds that person to the team.
    const assigned = await n8n.call('PATCH', '/v1/cards/c1', { assignees: ['Kim', 'Lee'] })
    expect(assigned.data.assignees.map((a: { name: string }) => a.name)).toEqual(['Kim', 'Lee'])
    let b = (await n8n.call('GET', '/v1/boards/b1')).data
    expect(b.team).toEqual([
      expect.objectContaining({ name: 'Kim', capacity: 0 }),
      expect.objectContaining({ name: 'Lee', capacity: 0 }),
    ])
    const kim = b.team[0].id

    const set = await n8n.call('PUT', '/v1/boards/b1/team/kim', { capacity: 1, color: '#30a46c' })
    expect(set.data).toEqual({ id: kim, name: 'Kim', color: '#30a46c', capacity: 1 })
    expect((await n8n.call('PUT', '/v1/boards/b1/team/Max', { capacity: 3 })).data).toMatchObject({ name: 'Max', capacity: 3 })
    expect((await n8n.call('PUT', '/v1/boards/b1/team/Max', { name: 'kim' })).status).toBe(409)
    expect((await n8n.call('PUT', '/v1/boards/b1/team/Max', { capacity: -1 })).status).toBe(400)

    const created = await n8n.call('POST', '/v1/boards/b1/cards', { column: 'To do', title: 'Hotel', assignees: [kim] })
    expect(created.data.assignees).toEqual([{ id: kim, name: 'Kim' }])
    await n8n.call('POST', '/v1/boards/b1/cards', { column: 'Done', title: 'Visa', assignees: ['Kim'] })
    await n8n.call('POST', '/v1/boards/b1/cards', { column: 'To do', title: 'Insurance' })

    expect((await n8n.call('GET', '/v1/cards?assignee=kim')).data.map((c: { title: string }) => c.title)).toEqual([
      'Book flights',
      'Hotel',
      'Visa',
    ])
    expect((await n8n.call('GET', '/v1/boards/b1/cards?assignee=none')).data.map((c: { title: string }) => c.title)).toEqual([
      'Insurance',
    ])

    const load = (await n8n.call('GET', '/v1/boards/b1/workload')).data
    expect(load.boards).toEqual([{ id: 'b1', title: 'Trip' }])
    const byName = Object.fromEntries(load.members.map((m: { name: string }) => [m.name, m]))
    expect(byName.Kim).toMatchObject({ openCount: 2, doneCount: 1, capacity: 1, level: 'over' })
    expect(byName.Kim.openCards.map((c: { title: string }) => c.title)).toEqual(['Book flights', 'Hotel'])
    expect(byName.Max).toMatchObject({ openCount: 0, level: 'free' })
    expect(load.unassigned.map((c: { title: string }) => c.title)).toEqual(['Insurance'])

    // Across boards, the same name counts as one person.
    const other = (await n8n.call('POST', '/v1/boards', { title: 'Home' })).data
    await n8n.call('POST', `/v1/boards/${other.id}/cards`, { column: 'To do', title: 'Paint', assignees: ['kim'] })
    const all = (await n8n.call('GET', '/v1/workload')).data
    expect(all.members.find((m: { name: string }) => m.name.toLowerCase() === 'kim')).toMatchObject({
      openCount: 3,
      memberIds: [expect.any(String), expect.any(String)],
    })

    // Removing someone takes them off their cards.
    expect((await n8n.call('DELETE', '/v1/boards/b1/team/Kim')).status).toBe(200)
    expect((await n8n.call('GET', '/v1/cards/c1')).data.assignees.map((a: { name: string }) => a.name)).toEqual(['Lee'])
    expect((await n8n.call('DELETE', '/v1/boards/b1/team/Kim')).status).toBe(404)

    const viewer = await apiKeyFor(await share(ana, 'ben@example.com', 'viewer'))
    expect((await viewer.call('GET', '/v1/boards/b1/workload')).status).toBe(200)
    expect((await viewer.call('PUT', '/v1/boards/b1/team/Ben', {})).status).toBe(403)
    expect((await viewer.call('DELETE', '/v1/boards/b1/team/Lee')).status).toBe(403)
    expect((await viewer.call('PATCH', '/v1/cards/c1', { assignees: [] })).status).toBe(403)
    const stranger = await apiKeyFor(await signUp('eve@example.com'))
    expect((await stranger.call('GET', '/v1/boards/b1/workload')).status).toBe(404)
    expect((await stranger.call('PUT', '/v1/boards/b1/team/Eve', {})).status).toBe(404)
    expect((await stranger.call('GET', '/v1/workload')).data).toMatchObject({ boards: [], members: [], unassigned: [] })
  })

  it('refuses to move a card into a column on another board', async () => {
    const ana = await ownerWithBoard()
    const n8n = await apiKeyFor(ana)
    const other = (await n8n.call('POST', '/v1/boards', { title: 'Other' })).data
    const res = await n8n.call('PATCH', '/v1/cards/c1', { column: other.columns[0].id })
    expect(res.status).toBe(404)
    expect((await n8n.call('GET', '/v1/cards/c1')).data.boardId).toBe('b1')
  })

  it('tells the app’s live updates about changes made through the API', async () => {
    const ana = await ownerWithBoard()
    const n8n = await apiKeyFor(ana)
    const stop = await events.start()
    received = []
    await n8n.call('POST', '/v1/boards/b1/cards', { column: 'To do', title: 'From n8n' })
    await new Promise((r) => setTimeout(r, 50))
    await stop()
    expect(received.map((r) => r.event)).toContainEqual(expect.objectContaining({ type: 'board', boardId: 'b1' }))
  })
})

describe('MCP endpoint', () => {
  const rpc = (n8n: Awaited<ReturnType<typeof apiKeyFor>>, method: string, params?: unknown, id: number | null = 1) =>
    n8n.call('POST', '/mcp', { jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }, {
      accept: 'application/json, text/event-stream',
    })

  it('initializes, lists tools and runs them as the key’s owner', async () => {
    const n8n = await apiKeyFor(await ownerWithBoard())
    const init = await rpc(n8n, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'n8n', version: '1' },
    })
    expect(init.data.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'todolist-kanban' },
    })
    expect((await rpc(n8n, 'notifications/initialized', undefined, null)).status).toBe(202)
    expect((await rpc(n8n, 'ping')).data.result).toEqual({})

    const { tools } = (await rpc(n8n, 'tools/list')).data.result
    expect(tools.map((t: { name: string }) => t.name)).toEqual(
      expect.arrayContaining(['list_boards', 'get_board', 'create_card', 'move_card', 'find_cards']),
    )
    expect(tools[0].inputSchema.type).toBe('object')

    const created = await rpc(n8n, 'tools/call', {
      name: 'create_card',
      arguments: { boardId: 'b1', column: 'To do', title: 'Call the hotel', labels: ['Booking'] },
    })
    const card = JSON.parse(created.data.result.content[0].text)
    expect(card).toMatchObject({ title: 'Call the hotel', column: 'To do', labels: [{ name: 'Booking' }] })
    const moved = await rpc(n8n, 'tools/call', { name: 'move_card', arguments: { cardId: card.id, column: 'Done' } })
    expect(JSON.parse(moved.data.result.content[0].text)).toMatchObject({ column: 'Done' })
    const found = await rpc(n8n, 'tools/call', { name: 'find_cards', arguments: { search: 'hotel' } })
    expect(JSON.parse(found.data.result.content[0].text)).toHaveLength(1)

    const progressed = await rpc(n8n, 'tools/call', {
      name: 'add_progress_note',
      arguments: { cardId: card.id, text: 'Left a voicemail', progress: 50 },
    })
    expect(JSON.parse(progressed.data.result.content[0].text)).toMatchObject({
      progress: 50,
      progressLog: [{ text: 'Left a voicemail', progress: 50 }],
    })
    const updated = await rpc(n8n, 'tools/call', { name: 'update_card', arguments: { cardId: card.id, progress: 100 } })
    expect(JSON.parse(updated.data.result.content[0].text)).toMatchObject({ progress: 100 })

    const call = async (name: string, args: object) =>
      JSON.parse((await rpc(n8n, 'tools/call', { name, arguments: args })).data.result.content[0].text)
    expect(await call('set_team_member', { boardId: 'b1', member: 'Kim', capacity: 1 })).toMatchObject({ name: 'Kim', capacity: 1 })
    // Assigning through MCP waits for the owner (see "assignment approval" below).
    expect(await call('update_card', { cardId: 'c1', assignees: ['Kim'] })).toMatchObject({
      assignees: [],
      pendingAssignment: { assignees: [{ name: 'Kim' }] },
    })
    expect((await n8n.call('PATCH', '/v1/cards/c1', { assignees: ['Kim'] })).status).toBe(200)
    expect(await call('find_cards', { assignee: 'Kim' })).toHaveLength(1)
    const load = await call('get_workload', { boardId: 'b1' })
    expect(load.members).toEqual([expect.objectContaining({ name: 'Kim', openCount: 1, level: 'full' })])
    expect(await call('remove_team_member', { boardId: 'b1', member: 'Kim' })).toEqual({ ok: true })

    const createTool = tools.find((t: { name: string }) => t.name === 'create_card')
    expect(Object.keys(createTool.inputSchema.properties)).toEqual(expect.arrayContaining(['startDate', 'dueDate']))
    const undated = await rpc(n8n, 'tools/call', {
      name: 'create_card',
      arguments: { boardId: 'b1', column: 'To do', title: 'Migrate EDI', labels: ['R4C'] },
    })
    expect(undated.data.result.isError).toBe(true)
    expect(undated.data.result.content[0].text).toMatch(/R4C cards need a start date and an end date/)
    const dated = await call('create_card', {
      boardId: 'b1',
      column: 'To do',
      title: 'Migrate EDI',
      labels: ['R4C'],
      startDate: '2026-11-01',
      dueDate: '2026-11-20',
    })
    expect(dated).toMatchObject({ startDate: '2026-11-01', dueDate: '2026-11-20' })
    expect(await call('update_card', { cardId: dated.id, startDate: '2026-11-02' })).toMatchObject({
      startDate: '2026-11-02',
    })
    const sized = await call('create_card', { boardId: 'b1', column: 'To do', title: 'Fix mapping', estimateDays: 2 })
    expect(sized).toMatchObject({ estimateDays: 2, startDate: null })
    // Moving into progress with move_card starts it; Done isn't "in progress", so a new column is added.
    await call('add_column', { boardId: 'b1', title: 'Doing' })
    expect(await call('move_card', { cardId: sized.id, column: 'Doing' })).toMatchObject({
      startDate: todayISO(),
      dueDate: dueFromEstimate(todayISO(), 2),
    })
  })

  it('returns refusals and bad input as tool errors, and unknown methods as JSON-RPC errors', async () => {
    const ana = await ownerWithBoard()
    const viewer = await apiKeyFor(await share(ana, 'ben@example.com', 'viewer'))
    const refused = await rpc(viewer, 'tools/call', {
      name: 'create_card',
      arguments: { boardId: 'b1', column: 'To do', title: 'x' },
    })
    expect(refused.data.result).toEqual({
      content: [{ type: 'text', text: 'You do not have permission to do that' }],
      isError: true,
    })
    const bad = await rpc(viewer, 'tools/call', { name: 'get_board', arguments: {} })
    expect(bad.data.result.isError).toBe(true)
    expect((await rpc(viewer, 'tools/call', { name: 'nope' })).data.error.code).toBe(-32602)
    expect((await rpc(viewer, 'resources/list')).data.error.code).toBe(-32601)
    expect((await viewer.call('GET', '/mcp')).status).toBe(405)
    const res = await app.request('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(401)
  })

  it('answers at the site address and with a trailing slash too', async () => {
    const n8n = await apiKeyFor(await ownerWithBoard())
    const headers = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'kanban.example.com' }
    const list = (path: string, auth: Record<string, string> = { authorization: `Bearer ${n8n.key}` }) =>
      app.request(path, {
        method: 'POST',
        headers: { ...headers, ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
    for (const path of ['/', '/api/mcp/']) {
      const res = await list(path)
      expect(res.status).toBe(200)
      expect((await res.json()).result.tools.length).toBeGreaterThan(0)
    }

    const unauthorized = await list('/', {})
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://kanban.example.com/.well-known/oauth-protected-resource"',
    )
    const revoked = await list('/', { authorization: 'Bearer kbo_nope' })
    expect(revoked.headers.get('www-authenticate')).toContain('error="invalid_token"')
    const resource = await (await app.request('/.well-known/oauth-protected-resource', { headers })).json()
    expect(resource.resource).toBe('https://kanban.example.com/')
    const slashed = await (await app.request('/.well-known/oauth-protected-resource/api/mcp/', { headers })).json()
    expect(slashed.resource).toBe('https://kanban.example.com/api/mcp')

    const stream = await app.request('/', { headers: { accept: 'text/event-stream' } })
    expect(stream.status).toBe(405)
    expect((await app.request('/', { method: 'DELETE' })).status).toBe(405)
    expect((await app.request('/api/mcp/', { headers: { 'x-api-key': n8n.key } })).status).toBe(405)
    expect((await app.request('/', { headers: { accept: 'text/html' } })).status).not.toBe(405)
  })
})

describe('assignment approval', () => {
  const tool = async (n8n: Awaited<ReturnType<typeof apiKeyFor>>, name: string, args: object) => {
    const res = await n8n.call(
      'POST',
      '/mcp',
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      { accept: 'application/json, text/event-stream' },
    )
    const { isError, content } = res.data.result
    return { isError: !!isError, data: isError ? content[0].text : JSON.parse(content[0].text) }
  }

  it('holds assignments made through MCP until the owner approves them', async () => {
    const ana = await ownerWithBoard()
    const claude = await apiKeyFor(ana, 'Claude')
    await claude.call('PUT', '/v1/boards/b1/team/Kim', {})

    const updated = await tool(claude, 'update_card', { cardId: 'c1', assignees: ['kim', 'Lee'], priority: 'low' })
    expect(updated.isError).toBe(false)
    // Other fields change right away; the assignees don't, and Lee doesn't join the team yet.
    expect(updated.data).toMatchObject({
      priority: 'low',
      assignees: [],
      pendingAssignment: {
        assignees: [{ id: expect.any(String), name: 'Kim' }, { id: null, name: 'Lee' }],
        requestedBy: 'ana@example.com',
      },
    })
    const stored = (await ana.call('GET', '/boards/b1')).data
    expect(stored.cards[0].assignee_ids).toEqual([])
    expect(stored.board.team.map((m: { name: string }) => m.name)).toEqual(['Kim'])

    const listed = await ana.call('GET', '/boards/b1/assignment-requests')
    expect(listed.data).toEqual([
      expect.objectContaining({ cardId: 'c1', assignees: updated.data.pendingAssignment.assignees }),
    ])
    expect((await tool(claude, 'get_card', { cardId: 'c1' })).data.pendingAssignment).not.toBeNull()

    expect((await ana.call('POST', '/boards/b1/assignment-requests/c1/approve', {})).status).toBe(200)
    const approved = (await ana.call('GET', '/boards/b1')).data
    expect(approved.board.team.map((m: { name: string }) => m.name)).toEqual(['Kim', 'Lee'])
    expect(approved.cards[0].assignee_ids).toEqual(approved.board.team.map((m: { id: string }) => m.id))
    expect((await ana.call('GET', '/boards/b1/assignment-requests')).data).toEqual([])
    expect((await tool(claude, 'get_card', { cardId: 'c1' })).data.pendingAssignment).toBeNull()
    expect((await ana.call('POST', '/boards/b1/assignment-requests/c1/approve', {})).status).toBe(404)
  })

  it('creates MCP cards unassigned with a request, replaces older requests and lets the owner reject', async () => {
    const ana = await ownerWithBoard()
    const claude = await apiKeyFor(ana, 'Claude')
    const created = await tool(claude, 'create_card', { boardId: 'b1', column: 'To do', title: 'Hotel', assignees: ['Kim'] })
    expect(created.data).toMatchObject({ assignees: [], pendingAssignment: { assignees: [{ id: null, name: 'Kim' }] } })
    const id = created.data.id as string

    await tool(claude, 'update_card', { cardId: id, assignees: ['Lee'] })
    const requests = (await ana.call('GET', '/boards/b1/assignment-requests')).data
    expect(requests).toEqual([expect.objectContaining({ cardId: id, assignees: [{ id: null, name: 'Lee' }] })])

    // Asking for what the card already has drops the request.
    await tool(claude, 'update_card', { cardId: id, assignees: [] })
    expect((await ana.call('GET', '/boards/b1/assignment-requests')).data).toEqual([])

    await tool(claude, 'update_card', { cardId: id, assignees: ['Lee'] })
    // Settling a request (which changes no card) still tells open apps, so the owner's other devices update.
    const stop = await events.start()
    received = []
    expect((await ana.call('POST', `/boards/b1/assignment-requests/${id}/reject`, {})).status).toBe(200)
    await new Promise((r) => setTimeout(r, 50))
    await stop()
    expect(received).toContainEqual({ userId: ana.user.id, event: { type: 'board', boardId: 'b1' } })
    const after = (await ana.call('GET', '/boards/b1')).data
    expect(after.cards.find((c: { id: string }) => c.id === id).assignee_ids).toEqual([])
    expect(after.board.team).toEqual([])
    expect((await ana.call('GET', '/boards/b1/assignment-requests')).data).toEqual([])

    // A deleted card takes its request with it.
    await tool(claude, 'update_card', { cardId: id, assignees: ['Lee'] })
    await claude.call('DELETE', `/v1/cards/${id}`)
    expect((await ana.call('GET', '/boards/b1/assignment-requests')).data).toEqual([])
  })

  it('only lets the board owner approve or reject, and only in the app', async () => {
    const ana = await ownerWithBoard()
    const ben = await share(ana, 'ben@example.com', 'editor')
    const cy = await share(ana, 'cy@example.com', 'viewer')
    const stranger = await signUp('dee@example.com')
    const bensKey = await apiKeyFor(ben)
    const anasKey = await apiKeyFor(ana)

    // An editor's agent can ask too; it still waits for the owner.
    expect((await tool(bensKey, 'update_card', { cardId: 'c1', assignees: ['Kim'] })).data.pendingAssignment).toMatchObject({
      requestedBy: 'ben@example.com',
    })
    const cyKey = await apiKeyFor(cy)
    expect((await tool(cyKey, 'update_card', { cardId: 'c1', assignees: ['Kim'] })).isError).toBe(true)

    expect((await cy.call('GET', '/boards/b1/assignment-requests')).data).toHaveLength(1)
    expect((await stranger.call('GET', '/boards/b1/assignment-requests')).status).toBe(404)
    for (const who of [ben, cy]) {
      expect((await who.call('POST', '/boards/b1/assignment-requests/c1/approve', {})).status).toBe(403)
      expect((await who.call('POST', '/boards/b1/assignment-requests/c1/reject', {})).status).toBe(403)
    }
    expect((await stranger.call('POST', '/boards/b1/assignment-requests/c1/approve', {})).status).toBe(404)
    // The owner's own API key can't approve either: approval happens in the app.
    expect((await anasKey.call('POST', '/boards/b1/assignment-requests/c1/approve')).status).toBe(403)
    expect((await anasKey.call('POST', '/boards/b1/assignment-requests/c1/reject')).status).toBe(403)
    expect((await ana.call('GET', '/boards/b1/assignment-requests')).data).toHaveLength(1)
    expect((await ana.call('POST', '/boards/b1/assignment-requests/c1/reject', {})).status).toBe(200)
  })
})

describe('OAuth for MCP clients', () => {
  const redirect = 'https://claude.ai/api/mcp/auth_callback'
  const verifier = 'a'.repeat(20) + '-b.c~d_' + 'e'.repeat(30)
  const challenge = createHash('sha256').update(verifier).digest('base64url')

  /** A browser: keeps cookies, doesn't follow redirects. */
  function browser() {
    const jar = new Map<string, string>()
    return async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers)
      if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '))
      const res = await app.request(path, { ...init, headers })
      for (const cookie of res.headers.getSetCookie()) {
        const [pair] = cookie.split(';')
        const [name, value] = pair.split('=')
        jar.set(name, value)
      }
      return res
    }
  }

  const form = (fields: Record<string, string>) => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })

  async function register(extra: Record<string, unknown> = { token_endpoint_auth_method: 'none' }) {
    const res = await app.request('/api/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect], ...extra }),
    })
    return { status: res.status, data: (await res.json()) as Record<string, string> }
  }

  const authorizeQuery = (clientId: string, extra: Record<string, string> = {}) =>
    new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      ...extra,
    }).toString()

  /** The hidden fields of the consent page, as its form would post them. */
  const fieldsOf = (html: string) =>
    Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2]]))

  /** Sign in on the consent page and allow; returns the code. */
  async function authorize(clientId: string) {
    const visit = browser()
    const page = await visit(`/api/oauth/authorize?${authorizeQuery(clientId)}`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('Allow Claude to use your boards?')
    expect(html).toContain('Sign in and allow')
    const res = await visit(
      '/api/oauth/authorize',
      form({ ...fieldsOf(html), email: 'ana@example.com', password: 'correct horse', decision: 'allow' }),
    )
    expect(res.status).toBe(302)
    const back = new URL(res.headers.get('location')!)
    expect(back.origin + back.pathname).toBe(redirect)
    expect(back.searchParams.get('state')).toBe('xyz')
    return { code: back.searchParams.get('code')!, visit }
  }

  async function token(fields: Record<string, string>, headers: Record<string, string> = {}) {
    const init = form(fields)
    const res = await app.request('/api/oauth/token', { ...init, headers: { ...init.headers, ...headers } })
    return { status: res.status, data: (await res.json()) as Record<string, string> }
  }

  const mcp = (accessToken: string, method: string, params?: unknown) =>
    app.request('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })

  it('publishes discovery documents and points MCP clients at them', async () => {
    const headers = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'kanban.example.com' }
    const unauthorized = await app.request('/api/mcp', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://kanban.example.com/.well-known/oauth-protected-resource/api/mcp"',
    )
    const resource = await (await app.request('/.well-known/oauth-protected-resource/api/mcp', { headers })).json()
    expect(resource).toMatchObject({
      resource: 'https://kanban.example.com/api/mcp',
      authorization_servers: ['https://kanban.example.com'],
    })
    const server = await (await app.request('/.well-known/oauth-authorization-server', { headers })).json()
    expect(server).toMatchObject({
      issuer: 'https://kanban.example.com',
      authorization_endpoint: 'https://kanban.example.com/api/oauth/authorize',
      token_endpoint: 'https://kanban.example.com/api/oauth/token',
      registration_endpoint: 'https://kanban.example.com/api/oauth/register',
      code_challenge_methods_supported: ['S256'],
    })

    const configured = createApp({ db, events, publicUrl: 'https://workstream.example.org/' })
    const meta = await (await configured.request('/.well-known/oauth-authorization-server')).json()
    expect(meta.issuer).toBe('https://workstream.example.org')
  })

  it('registers clients, signs in, allows, and gives working tokens that refresh', async () => {
    const ana = await ownerWithBoard()
    const { status, data: client } = await register()
    expect(status).toBe(201)
    expect(client.client_secret).toBeUndefined()

    const { code } = await authorize(client.client_id)
    const wrong = await token({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      redirect_uri: redirect,
      code_verifier: 'x'.repeat(43),
    })
    expect(wrong).toMatchObject({ status: 400, data: { error: 'invalid_grant' } })

    // The failed attempt used up the code; sign in again for a new one.
    const again = await authorize(client.client_id)
    const exchange = {
      grant_type: 'authorization_code',
      code: again.code,
      client_id: client.client_id,
      redirect_uri: redirect,
      code_verifier: verifier,
    }
    const issued = await token(exchange)
    expect(issued.status).toBe(200)
    expect(issued.data).toMatchObject({ token_type: 'Bearer', expires_in: 3600 })
    expect((await token(exchange)).data.error).toBe('invalid_grant')

    const tools = await mcp(issued.data.access_token, 'tools/call', { name: 'list_boards', arguments: {} })
    const boards = JSON.parse(((await tools.json()) as any).result.content[0].text)
    expect(boards).toEqual([expect.objectContaining({ id: 'b1', role: 'owner' })])

    // A stale API key in an extra header doesn't block the OAuth token that comes with it.
    const both = await app.request('/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'kbn_revoked',
        authorization: `Bearer ${issued.data.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    })
    expect(both.status).toBe(200)

    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token: issued.data.refresh_token,
      client_id: client.client_id,
    })
    expect(refreshed.status).toBe(200)
    expect(refreshed.data.access_token).not.toBe(issued.data.access_token)
    const reused = await token({
      grant_type: 'refresh_token',
      refresh_token: issued.data.refresh_token,
      client_id: client.client_id,
    })
    expect(reused.data.error).toBe('invalid_grant')
    expect((await mcp(refreshed.data.access_token, 'ping')).status).toBe(200)

    // The app lists the connection, and disconnecting it stops its tokens.
    const apps = (await ana.call('GET', '/connected-apps')).data
    expect(apps).toEqual([expect.objectContaining({ id: client.client_id, name: 'Claude' })])
    const asApp = await app.request('/api/connected-apps', {
      headers: { authorization: `Bearer ${refreshed.data.access_token}` },
    })
    expect(asApp.status).toBe(403)
    await ana.call('DELETE', `/connected-apps/${client.client_id}`)
    expect((await mcp(refreshed.data.access_token, 'ping')).status).toBe(401)
    const afterDisconnect = await token({
      grant_type: 'refresh_token',
      refresh_token: refreshed.data.refresh_token,
      client_id: client.client_id,
    })
    expect(afterDisconnect.data.error).toBe('invalid_grant')
  })

  it('gives OAuth tokens their owner’s role on each board', async () => {
    const ana = await ownerWithBoard()
    await share(ana, 'ben@example.com', 'viewer')
    const { data: client } = await register()
    const visit = browser()
    const html = await (await visit(`/api/oauth/authorize?${authorizeQuery(client.client_id)}`)).text()
    const res = await visit(
      '/api/oauth/authorize',
      form({ ...fieldsOf(html), email: 'ben@example.com', password: 'correct horse', decision: 'allow' }),
    )
    const code = new URL(res.headers.get('location')!).searchParams.get('code')!
    const { data } = await token({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      code_verifier: verifier,
    })
    const refused = await mcp(data.access_token, 'tools/call', {
      name: 'create_card',
      arguments: { boardId: 'b1', column: 'To do', title: 'x' },
    })
    expect(((await refused.json()) as any).result.isError).toBe(true)
  })

  it('requires the secret of clients that registered one', async () => {
    await ownerWithBoard()
    const { data: client } = await register({})
    expect(client.client_secret).toMatch(/^kbs_/)
    const { code } = await authorize(client.client_id)
    const fields = { grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier }
    expect((await token({ ...fields, client_id: client.client_id })).status).toBe(401)
    const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')
    const ok = await token(fields, { authorization: `Basic ${basic}` })
    expect(ok.status).toBe(200)
  })

  it('refuses bad registrations, bad requests, forged forms and wrong passwords', async () => {
    await ownerWithBoard()
    expect((await register({ redirect_uris: ['http://evil.example.com/cb'] })).data.error).toBe('invalid_redirect_uri')
    expect((await register({ redirect_uris: [] })).data.error).toBe('invalid_redirect_uri')
    expect((await register({ grant_types: ['password'] })).data.error).toBe('invalid_client_metadata')
    const { data: client } = await register()

    expect((await app.request(`/api/oauth/authorize?${authorizeQuery('nope')}`)).status).toBe(400)
    const elsewhere = authorizeQuery(client.client_id, { redirect_uri: 'https://evil.example.com/cb' })
    const res = await app.request(`/api/oauth/authorize?${elsewhere}`)
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
    const noPkce = await app.request(`/api/oauth/authorize?${authorizeQuery(client.client_id, { code_challenge_method: 'plain' })}`)
    expect(new URL(noPkce.headers.get('location')!).searchParams.get('error')).toBe('invalid_request')

    const visit = browser()
    const html = await (await visit(`/api/oauth/authorize?${authorizeQuery(client.client_id)}`)).text()
    const fields = fieldsOf(html)
    const forged = await app.request(
      '/api/oauth/authorize',
      form({ ...fields, email: 'ana@example.com', password: 'correct horse', decision: 'allow' }),
    )
    expect(forged.status).toBe(400)
    expect(forged.headers.get('location')).toBeNull()

    const badPassword = await visit(
      '/api/oauth/authorize',
      form({ ...fields, email: 'ana@example.com', password: 'wrong', decision: 'allow' }),
    )
    expect(badPassword.status).toBe(400)
    expect(await badPassword.text()).toContain('Wrong email or password.')

    const html2 = await (await visit(`/api/oauth/authorize?${authorizeQuery(client.client_id)}`)).text()
    const denied = await visit('/api/oauth/authorize', form({ ...fieldsOf(html2), decision: 'deny' }))
    expect(new URL(denied.headers.get('location')!).searchParams.get('error')).toBe('access_denied')

    expect((await token({ grant_type: 'password', client_id: client.client_id })).data.error).toBe(
      'unsupported_grant_type',
    )
    expect((await token({ grant_type: 'authorization_code', client_id: 'nope' })).status).toBe(401)
    expect((await mcp('kbo_nope', 'ping')).headers.get('www-authenticate')).toContain('error="invalid_token"')
  })

  it('skips the password for someone already signed in to the app', async () => {
    const ana = await ownerWithBoard()
    const { data: client } = await register()
    // Reuse the app session by signing in through a browser.
    const visit = browser()
    await visit('/api/auth/signin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ana@example.com', password: 'correct horse' }),
    })
    const html = await (await visit(`/api/oauth/authorize?${authorizeQuery(client.client_id)}`)).text()
    expect(html).toContain('Signed in as <strong>ana@example.com</strong>')
    const res = await visit('/api/oauth/authorize', form({ ...fieldsOf(html), decision: 'allow' }))
    expect(new URL(res.headers.get('location')!).searchParams.get('code')).toBeTruthy()
    expect(ana.user.email).toBe('ana@example.com')
  })
})

describe('contacts', () => {
  const alex = {
    name: 'Alex Kim',
    company: 'Acme',
    jobTitle: 'Buyer',
    email: 'alex@acme.test',
    phone: '+66 81 234 5678',
    website: 'https://acme.test',
    address: 'Bangkok',
    notes: 'Prefers calls',
  }

  it('adds, lists, edits and deletes the caller’s own contacts', async () => {
    const ana = await signUp('ana@example.com')
    const created = await ana.call('POST', '/contacts', alex)
    expect(created.status).toBe(201)
    expect(created.data).toMatchObject({ ...alex, id: expect.any(String) })
    await ana.call('POST', '/contacts', { name: 'bea' })

    const list = await ana.call('GET', '/contacts')
    expect(list.data.map((c: { name: string }) => c.name)).toEqual(['Alex Kim', 'bea'])
    expect(list.data[1]).toMatchObject({ company: '', email: '' })

    const edited = await ana.call('PUT', `/contacts/${created.data.id}`, { ...alex, phone: '02 000 0000' })
    expect(edited.status).toBe(200)
    expect(edited.data.phone).toBe('02 000 0000')

    expect((await ana.call('DELETE', `/contacts/${created.data.id}`)).status).toBe(200)
    expect((await ana.call('GET', '/contacts')).data).toHaveLength(1)
  })

  it('refuses a contact without a name, and anyone without an account', async () => {
    const ana = await signUp('ana@example.com')
    expect((await ana.call('POST', '/contacts', { name: '  ' })).status).toBe(400)
    expect((await ana.call('POST', '/contacts', { name: 'x', email: 5 })).status).toBe(400)
    const res = await app.request('/api/contacts')
    expect(res.status).toBe(401)
  })

  it('keeps one user’s contacts from another', async () => {
    const ana = await signUp('ana@example.com')
    const ben = await signUp('ben@example.com')
    const { data } = await ana.call('POST', '/contacts', alex)
    expect((await ben.call('GET', '/contacts')).data).toEqual([])
    expect((await ben.call('PUT', `/contacts/${data.id}`, { name: 'Mine now' })).status).toBe(404)
    expect((await ben.call('DELETE', `/contacts/${data.id}`)).status).toBe(404)
    expect((await ben.call('DELETE', '/contacts/not-a-uuid')).status).toBe(404)
    expect((await ana.call('GET', '/contacts')).data[0].name).toBe('Alex Kim')
  })

  it('works with an API key too', async () => {
    const ana = await signUp('ana@example.com')
    const n8n = await apiKeyFor(ana)
    expect((await n8n.call('POST', '/contacts', { name: 'From n8n' })).status).toBe(201)
    expect((await ana.call('GET', '/contacts')).data[0].name).toBe('From n8n')
  })
})

describe('credentials', () => {
  const login = {
    name: 'Bank',
    kind: 'login',
    url: 'https://bank.test',
    notes: 'PIN is 1234',
    fields: [
      { name: 'Username', value: 'ana', secret: false, multiline: false },
      { name: 'Password', value: 'hunter2', secret: true, multiline: false },
    ],
  }

  it('stores secrets encrypted and returns them only when asked', async () => {
    const ana = await signUp('ana@example.com')
    const created = await ana.call('POST', '/credentials', login)
    expect(created.status).toBe(201)
    expect(created.data.fields).toEqual([
      { name: 'Username', value: 'ana', secret: false, multiline: false },
      { name: 'Password', value: null, secret: true, multiline: false },
    ])
    expect(JSON.stringify(created.data)).not.toContain('hunter2')

    const list = await ana.call('GET', '/credentials')
    expect(list.data.keySource).toBe('database')
    expect(list.data.credentials).toHaveLength(1)
    expect(JSON.stringify(list.data)).not.toMatch(/hunter2|PIN/)

    // Nothing readable in the database.
    const { rows } = await db.query<{ fields: unknown; secret: string }>('select fields, secret from kanban.credentials')
    expect(JSON.stringify(rows)).not.toMatch(/hunter2|PIN/)
    expect(rows[0].secret).toMatch(/^v1\.db\./)

    const secret = await ana.call('GET', `/credentials/${created.data.id}/secret`)
    expect(secret.data).toEqual({ fields: { Password: 'hunter2' }, notes: 'PIN is 1234' })
  })

  it('keeps saved secrets when an edit leaves them out, and replaces them when given', async () => {
    const ana = await signUp('ana@example.com')
    const { data } = await ana.call('POST', '/credentials', login)
    const keep = {
      ...login,
      name: 'My bank',
      notes: null,
      fields: [
        { name: 'Username', value: 'ana2', secret: false, multiline: false },
        { name: 'Password', value: null, secret: true, multiline: false },
        { name: 'Recovery code', value: 'abc', secret: true, multiline: false },
      ],
    }
    expect((await ana.call('PUT', `/credentials/${data.id}`, keep)).data.name).toBe('My bank')
    expect((await ana.call('GET', `/credentials/${data.id}/secret`)).data).toEqual({
      fields: { Password: 'hunter2', 'Recovery code': 'abc' },
      notes: 'PIN is 1234',
    })

    await ana.call('PUT', `/credentials/${data.id}`, { ...login, fields: [login.fields[1]], notes: '' })
    expect((await ana.call('GET', `/credentials/${data.id}/secret`)).data).toEqual({
      fields: { Password: 'hunter2' },
      notes: '',
    })
  })

  it('accepts every kind of credential and refuses bad input', async () => {
    const ana = await signUp('ana@example.com')
    for (const kind of ['api_key', 'bearer', 'oauth2', 'ssh', 'certificate', 'database', 'cloud', 'totp', 'other']) {
      const res = await ana.call('POST', '/credentials', { ...login, kind })
      expect(res.status).toBe(201)
    }
    expect((await ana.call('POST', '/credentials', { ...login, kind: 'magic' })).status).toBe(400)
    expect((await ana.call('POST', '/credentials', { ...login, name: '' })).status).toBe(400)
    const twice = { ...login, fields: [login.fields[0], { ...login.fields[0], name: 'username' }] }
    expect((await ana.call('POST', '/credentials', twice)).status).toBe(400)
    // A new credential has no saved value to keep.
    const missing = { ...login, fields: [{ ...login.fields[1], value: null }] }
    expect((await ana.call('POST', '/credentials', missing)).status).toBe(400)
  })

  it('keeps one user’s credentials from another', async () => {
    const ana = await signUp('ana@example.com')
    const ben = await signUp('ben@example.com')
    const { data } = await ana.call('POST', '/credentials', login)
    expect((await ben.call('GET', '/credentials')).data.credentials).toEqual([])
    expect((await ben.call('GET', `/credentials/${data.id}/secret`)).status).toBe(404)
    expect((await ben.call('PUT', `/credentials/${data.id}`, login)).status).toBe(404)
    expect((await ben.call('DELETE', `/credentials/${data.id}`)).status).toBe(404)
    expect((await ana.call('DELETE', `/credentials/${data.id}`)).status).toBe(200)
    expect((await ana.call('GET', `/credentials/${data.id}/secret`)).status).toBe(404)
  })

  it('refuses API keys and anyone signed out', async () => {
    const ana = await signUp('ana@example.com')
    const { data } = await ana.call('POST', '/credentials', login)
    const n8n = await apiKeyFor(ana)
    expect((await n8n.call('GET', '/credentials')).status).toBe(403)
    expect((await n8n.call('GET', `/credentials/${data.id}/secret`)).status).toBe(403)
    expect((await n8n.call('POST', '/credentials', login)).status).toBe(403)
    expect((await n8n.call('DELETE', `/credentials/${data.id}`)).status).toBe(403)
    expect((await app.request('/api/credentials')).status).toBe(401)
  })

  it('uses CREDENTIALS_KEY when set, and still opens secrets saved before it', async () => {
    const ana = await signUp('ana@example.com')
    const before = (await ana.call('POST', '/credentials', login)).data.id

    app = createApp({ db, events, credentialsKey: 'a long random key' })
    const after = (await ana.call('POST', '/credentials', login)).data.id
    expect((await ana.call('GET', '/credentials')).data.keySource).toBe('env')
    const { rows } = await db.query<{ secret: string }>('select secret from kanban.credentials where id = $1', [after])
    expect(rows[0].secret).toMatch(/^v1\.k[0-9a-f]{12}\./)
    expect((await ana.call('GET', `/credentials/${before}/secret`)).data.fields).toEqual({ Password: 'hunter2' })
    expect((await ana.call('GET', `/credentials/${after}/secret`)).data.fields).toEqual({ Password: 'hunter2' })

    // With a different key, the newer one can't be opened, and the server says why.
    app = createApp({ db, events, credentialsKey: 'some other key' })
    const wrong = await ana.call('GET', `/credentials/${after}/secret`)
    expect(wrong.status).toBe(409)
    expect(wrong.data.error).toMatch(/different CREDENTIALS_KEY/)
  })

  it('cannot move an encrypted secret to another row', async () => {
    const ana = await signUp('ana@example.com')
    const a = (await ana.call('POST', '/credentials', login)).data.id
    const b = (await ana.call('POST', '/credentials', { ...login, name: 'Other' })).data.id
    await db.query(
      'update kanban.credentials set secret = (select secret from kanban.credentials where id = $1) where id = $2',
      [a, b],
    )
    expect((await ana.call('GET', `/credentials/${b}/secret`)).status).toBe(409)
  })
})
