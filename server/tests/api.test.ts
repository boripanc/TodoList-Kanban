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
