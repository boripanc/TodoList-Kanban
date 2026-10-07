// @vitest-environment node
// Exercises the server API against an in-process Postgres (PGlite): accounts,
// sharing, roles, invites and live-update notifications.
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import type { Db, Queryable } from '../src/db.ts'
import { EventHub, type ServerEvent } from '../src/events.ts'
import { migrate } from '../src/migrate.ts'

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
    'truncate kanban.users, kanban.sessions, kanban.boards, kanban.board_members, kanban.columns, kanban.cards, kanban.board_invites cascade',
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
    expect(doc.board).toEqual(board.board)
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

/** An automation tool (n8n) calling with a personal API token. */
async function tokenFor(person: Awaited<ReturnType<typeof signUp>>, name = 'n8n') {
  const res = await person.call('POST', '/tokens', { name })
  expect(res.status).toBe(200)
  const token = res.data.token as string
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    // oxlint-disable-next-line no-explicit-any -- test responses are checked by assertions
    const data = res.status === 202 ? null : ((await res.json()) as any)
    return { status: res.status, data, headers: res.headers }
  }
  return { token, id: res.data.id as string, call }
}

describe('API tokens', () => {
  it('creates a token shown once, signs in with it, and stops working once revoked', async () => {
    const ana = await signUp('ana@example.com')
    const n8n = await tokenFor(ana)
    expect(n8n.token).toMatch(/^kbn_/)
    expect((await n8n.call('GET', '/v1/me')).data).toEqual(ana.user)
    expect((await n8n.call('GET', '/auth/me')).data.user).toEqual(ana.user)

    const listed = (await ana.call('GET', '/tokens')).data
    expect(listed).toEqual([expect.objectContaining({ id: n8n.id, name: 'n8n', lastUsedAt: expect.any(String) })])
    expect(JSON.stringify(listed)).not.toContain(n8n.token)
    const { rows } = await db.query<{ token_hash: string }>('select token_hash from kanban.api_tokens')
    expect(rows[0].token_hash).not.toContain(n8n.token)

    expect((await ana.call('DELETE', `/tokens/${n8n.id}`)).status).toBe(200)
    const after = await n8n.call('GET', '/v1/boards')
    expect(after.status).toBe(401)
    expect(after.headers.get('www-authenticate')).toBe('Bearer')
  })

  it('refuses unknown tokens, other people’s tokens, and tokens managing tokens', async () => {
    const ana = await signUp('ana@example.com')
    const eve = await signUp('eve@example.com')
    const n8n = await tokenFor(ana)
    expect((await n8n.call('GET', '/tokens')).status).toBe(403)
    expect((await n8n.call('POST', '/tokens', { name: 'more' })).status).toBe(403)
    expect((await n8n.call('DELETE', `/tokens/${n8n.id}`)).status).toBe(403)
    // Eve can't revoke Ana's token.
    await eve.call('DELETE', `/tokens/${n8n.id}`)
    expect((await n8n.call('GET', '/v1/me')).status).toBe(200)
    expect((await eve.call('POST', '/tokens', { name: '' })).status).toBe(400)

    for (const header of ['Bearer kbn_nope', 'Bearer not-a-token', 'Bearer']) {
      const res = await app.request('/api/v1/boards', { headers: { authorization: header } })
      expect(res.status).toBe(401)
    }
    // A bad token isn't rescued by a session cookie that came along.
    const res = await app.request('/api/v1/boards', { headers: { authorization: 'Bearer kbn_nope', cookie: 'x=y' } })
    expect(res.status).toBe(401)
  })

  it('needs a signed-in session to manage tokens', async () => {
    const res = await app.request('/api/tokens')
    expect(res.status).toBe(401)
  })
})

describe('REST API (v1)', () => {
  it('serves its OpenAPI description without a token', async () => {
    const res = await app.request('/api/v1/openapi.json')
    expect(res.status).toBe(200)
    const spec = (await res.json()) as { openapi: string; paths: Record<string, unknown> }
    expect(spec.openapi).toBe('3.0.3')
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/boards', '/boards/{boardId}/cards', '/cards/{cardId}']))
  })

  it('creates a board and manages its columns', async () => {
    const n8n = await tokenFor(await signUp('ana@example.com'))
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
    const n8n = await tokenFor(ana)
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

  it('gives tokens their owner’s role on each board', async () => {
    const ana = await ownerWithBoard()
    const viewer = await tokenFor(await share(ana, 'ben@example.com', 'viewer'))
    const editor = await tokenFor(await share(ana, 'cat@example.com', 'editor'))
    const stranger = await tokenFor(await signUp('eve@example.com'))

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

  it('refuses to move a card into a column on another board', async () => {
    const ana = await ownerWithBoard()
    const n8n = await tokenFor(ana)
    const other = (await n8n.call('POST', '/v1/boards', { title: 'Other' })).data
    const res = await n8n.call('PATCH', '/v1/cards/c1', { column: other.columns[0].id })
    expect(res.status).toBe(404)
    expect((await n8n.call('GET', '/v1/cards/c1')).data.boardId).toBe('b1')
  })

  it('tells the app’s live updates about changes made through the API', async () => {
    const ana = await ownerWithBoard()
    const n8n = await tokenFor(ana)
    const stop = await events.start()
    received = []
    await n8n.call('POST', '/v1/boards/b1/cards', { column: 'To do', title: 'From n8n' })
    await new Promise((r) => setTimeout(r, 50))
    await stop()
    expect(received.map((r) => r.event)).toContainEqual(expect.objectContaining({ type: 'board', boardId: 'b1' }))
  })
})

describe('MCP endpoint', () => {
  const rpc = (n8n: Awaited<ReturnType<typeof tokenFor>>, method: string, params?: unknown, id: number | null = 1) =>
    n8n.call('POST', '/mcp', { jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }, {
      accept: 'application/json, text/event-stream',
    })

  it('initializes, lists tools and runs them as the token’s owner', async () => {
    const n8n = await tokenFor(await ownerWithBoard())
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
  })

  it('returns refusals and bad input as tool errors, and unknown methods as JSON-RPC errors', async () => {
    const ana = await ownerWithBoard()
    const viewer = await tokenFor(await share(ana, 'ben@example.com', 'viewer'))
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
})
