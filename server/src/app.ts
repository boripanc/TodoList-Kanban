import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import { streamSSE } from 'hono/streaming'
import type { CardRow, ColumnRow } from '../../src/cloud/doc.ts'
import { hashPassword, hashToken, MIN_PASSWORD_LENGTH, newToken, verifyPassword } from './auth.ts'
import type { Db, Queryable } from './db.ts'
import type { EventHub } from './events.ts'
import * as v from './validate.ts'

type Role = 'owner' | 'editor' | 'viewer'
type User = { id: string; email: string }
type Env = { Variables: { user: User } }

export const SESSION_COOKIE = 'kanban_session'
const SESSION_DAYS = 30

export interface AppOptions {
  db: Db
  events: EventHub
  /** Mark the session cookie Secure (set when serving over https). */
  secureCookies?: boolean
}

const fail = (status: 400 | 401 | 403 | 404 | 409 | 429, message: string): never => {
  throw new HTTPException(status, { message })
}

/** Simple in-memory limit on failed sign-ins per email, to slow down password guessing. */
function createSignInLimiter(maxFailures = 10, windowMs = 15 * 60 * 1000) {
  const failures = new Map<string, { count: number; since: number }>()
  return {
    check(key: string) {
      const entry = failures.get(key)
      if (entry && Date.now() - entry.since < windowMs && entry.count >= maxFailures) {
        fail(429, 'Too many attempts. Try again in a few minutes.')
      }
    },
    failed(key: string) {
      const entry = failures.get(key)
      if (!entry || Date.now() - entry.since >= windowMs) failures.set(key, { count: 1, since: Date.now() })
      else entry.count++
    },
    succeeded(key: string) {
      failures.delete(key)
    },
  }
}

export function createApp({ db, events, secureCookies = false }: AppOptions) {
  const app = new Hono<Env>().basePath('/api')
  const limiter = createSignInLimiter()

  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status)
    if (error instanceof v.BadRequest) return c.json({ error: error.message }, 400)
    console.error(error)
    return c.json({ error: 'Something went wrong on the server.' }, 500)
  })

  app.use(bodyLimit({ maxSize: 2 * 1024 * 1024 }))

  // Changes must be JSON: browsers can't send that cross-site without a CORS
  // preflight, which this server never allows. Together with SameSite cookies
  // this stops other sites from acting as a signed-in user.
  app.use(async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      if (!c.req.header('content-type')?.startsWith('application/json')) fail(400, 'Expected JSON')
    }
    await next()
  })

  const body = async (c: Context) => {
    try {
      return (await c.req.json()) as Record<string, unknown>
    } catch {
      return fail(400, 'Expected JSON')
    }
  }

  async function startSession(c: Context, userId: string) {
    const token = newToken()
    await db.query(
      `insert into kanban.sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '${SESSION_DAYS} days')`,
      [hashToken(token), userId],
    )
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: secureCookies,
      path: '/',
      maxAge: SESSION_DAYS * 24 * 60 * 60,
    })
  }

  async function currentUser(c: Context): Promise<User | null> {
    const token = getCookie(c, SESSION_COOKIE)
    if (!token) return null
    const { rows } = await db.query<User>(
      `select u.id, u.email from kanban.sessions s join kanban.users u on u.id = s.user_id
       where s.token_hash = $1 and s.expires_at > now()`,
      [hashToken(token)],
    )
    return rows[0] ?? null
  }

  // --- Accounts ---

  app.post('/auth/signup', async (c) => {
    const b = await body(c)
    const email = v.email(b.email)
    const password = typeof b.password === 'string' ? b.password : ''
    if (password.length < MIN_PASSWORD_LENGTH) fail(400, `Use a password of at least ${MIN_PASSWORD_LENGTH} characters`)
    const hash = await hashPassword(password)
    const { rows } = await db.query<User>(
      `insert into kanban.users (email, password_hash) values ($1, $2)
       on conflict ((lower(email))) do nothing returning id, email`,
      [email, hash],
    )
    if (!rows[0]) fail(409, 'An account with this email already exists. Sign in instead.')
    await startSession(c, rows[0].id)
    return c.json({ user: rows[0] })
  })

  app.post('/auth/signin', async (c) => {
    const b = await body(c)
    const email = v.email(b.email)
    limiter.check(email)
    const password = typeof b.password === 'string' ? b.password : ''
    const { rows } = await db.query<User & { password_hash: string }>(
      'select id, email, password_hash from kanban.users where lower(email) = $1',
      [email],
    )
    const user = rows[0]
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      limiter.failed(email)
      fail(401, 'Wrong email or password')
    }
    limiter.succeeded(email)
    await startSession(c, user.id)
    return c.json({ user: { id: user.id, email: user.email } })
  })

  app.post('/auth/signout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE)
    if (token) await db.query('delete from kanban.sessions where token_hash = $1', [hashToken(token)])
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  app.get('/auth/me', async (c) => c.json({ user: await currentUser(c) }))

  // Everything below needs a signed-in user.
  app.use(async (c, next) => {
    const user = await currentUser(c)
    if (!user) fail(401, 'Sign in first')
    c.set('user', user!)
    await next()
  })

  async function roleOf(q: Queryable, boardId: string, userId: string): Promise<Role | undefined> {
    const { rows } = await q.query<{ role: Role }>(
      'select role from kanban.board_members where board_id = $1 and user_id = $2',
      [boardId, userId],
    )
    return rows[0]?.role
  }

  async function requireRole(q: Queryable, boardId: string, userId: string, allowed: Role[]) {
    const role = await roleOf(q, boardId, userId)
    if (!role) fail(404, 'Board not found')
    if (!allowed.includes(role!)) fail(403, 'You do not have permission to do that')
    return role!
  }

  // --- Boards ---

  app.get('/boards', async (c) => {
    const { rows } = await db.query<{ id: string; role: Role; updated_at: Date }>(
      `select b.id, m.role, b.updated_at from kanban.board_members m join kanban.boards b on b.id = m.board_id
       where m.user_id = $1`,
      [c.get('user').id],
    )
    return c.json(rows.map((r) => ({ id: r.id, role: r.role, updatedAt: new Date(r.updated_at).toISOString() })))
  })

  app.get('/boards/:id', async (c) => {
    const boardId = c.req.param('id')
    await requireRole(db, boardId, c.get('user').id, ['owner', 'editor', 'viewer'])
    const [board, columns, cards] = await Promise.all([
      db.query('select id, title, labels, created_at from kanban.boards where id = $1', [boardId]),
      db.query('select id, board_id, position, title, wip_limit from kanban.columns where board_id = $1', [boardId]),
      db.query('select * from kanban.cards where board_id = $1', [boardId]),
    ])
    const row = board.rows[0] as { created_at: string | number } | undefined
    if (!row) fail(404, 'Board not found')
    return c.json({
      board: { ...row, created_at: Number(row!.created_at) },
      columns: columns.rows,
      cards: (cards.rows as unknown as (CardRow & { created_at: string | number; updated_at: string | number })[]).map(
        (card) => ({
          ...card,
          created_at: Number(card.created_at),
          updated_at: Number(card.updated_at),
        }),
      ),
    })
  })

  async function upsertColumns(q: Queryable, boardId: string, columns: ColumnRow[]) {
    for (const col of columns) {
      // Only rows on this board can be updated; an id taken by another board fails instead.
      const { rows } = await q.query(
        `insert into kanban.columns (id, board_id, position, title, wip_limit) values ($1, $2, $3, $4, $5)
         on conflict (id) do update set position = excluded.position, title = excluded.title, wip_limit = excluded.wip_limit
         where kanban.columns.board_id = excluded.board_id
         returning id`,
        [col.id, boardId, col.position, col.title, col.wip_limit],
      )
      if (!rows[0]) fail(409, 'That column id is already in use')
    }
  }

  async function upsertCards(q: Queryable, boardId: string, cards: CardRow[]) {
    for (const card of cards) {
      const { rows } = await q.query(
        `insert into kanban.cards (id, board_id, column_id, position, title, description, label_ids, priority,
           due_date, checklist, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         on conflict (id) do update set column_id = excluded.column_id, position = excluded.position,
           title = excluded.title, description = excluded.description, label_ids = excluded.label_ids,
           priority = excluded.priority, due_date = excluded.due_date, checklist = excluded.checklist,
           updated_at = excluded.updated_at
         where kanban.cards.board_id = excluded.board_id
         returning id`,
        [
          card.id,
          boardId,
          card.column_id,
          card.position,
          card.title,
          card.description,
          JSON.stringify(card.label_ids),
          card.priority,
          card.due_date,
          JSON.stringify(card.checklist),
          card.created_at,
          card.updated_at,
        ],
      )
      if (!rows[0]) fail(409, 'That card id is already in use')
    }
  }

  app.post('/boards', async (c) => {
    const b = await body(c)
    const board = v.boardRow(b.board)
    const columns = v.arrOf(b.columns, (x) => v.columnRow(x, board.id))
    const cards = v.arrOf(b.cards, (x) => v.cardRow(x, board.id))
    const userId = c.get('user').id
    await db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `insert into kanban.boards (id, owner_id, title, labels, created_at) values ($1, $2, $3, $4, $5)
         on conflict (id) do nothing returning id`,
        [board.id, userId, board.title, JSON.stringify(board.labels), board.created_at],
      )
      if (!rows[0]) fail(409, 'A board with this id already exists')
      await tx.query("insert into kanban.board_members (board_id, user_id, role) values ($1, $2, 'owner')", [
        board.id,
        userId,
      ])
      await upsertColumns(tx, board.id, columns)
      await upsertCards(tx, board.id, cards)
    })
    return c.json({ ok: true })
  })

  app.post('/boards/:id/changes', async (c) => {
    const boardId = c.req.param('id')
    const ops = v.boardOps(await body(c), boardId)
    await db.transaction(async (tx) => {
      await requireRole(tx, boardId, c.get('user').id, ['owner', 'editor'])
      if (ops.board) {
        await tx.query('update kanban.boards set title = $2, labels = $3 where id = $1', [
          boardId,
          ops.board.title,
          JSON.stringify(ops.board.labels),
        ])
      }
      // Columns exist before cards move into them; cards go before their columns.
      await upsertColumns(tx, boardId, ops.upsertColumns)
      await upsertCards(tx, boardId, ops.upsertCards)
      if (ops.deleteCardIds.length) {
        await tx.query('delete from kanban.cards where board_id = $1 and id = any($2)', [boardId, ops.deleteCardIds])
      }
      if (ops.deleteColumnIds.length) {
        await tx.query('delete from kanban.columns where board_id = $1 and id = any($2)', [
          boardId,
          ops.deleteColumnIds,
        ])
      }
    })
    return c.json({ ok: true })
  })

  app.delete('/boards/:id', async (c) => {
    const boardId = c.req.param('id')
    await requireRole(db, boardId, c.get('user').id, ['owner'])
    await db.query('delete from kanban.boards where id = $1', [boardId])
    return c.json({ ok: true })
  })

  // --- Members ---

  app.get('/boards/:id/members', async (c) => {
    const boardId = c.req.param('id')
    await requireRole(db, boardId, c.get('user').id, ['owner', 'editor', 'viewer'])
    const { rows } = await db.query<{ userId: string; email: string; role: Role }>(
      `select m.user_id as "userId", u.email, m.role from kanban.board_members m join kanban.users u on u.id = m.user_id
       where m.board_id = $1
       order by case m.role when 'owner' then 0 when 'editor' then 1 else 2 end, u.email`,
      [boardId],
    )
    return c.json(rows)
  })

  app.patch('/boards/:id/members/:userId', async (c) => {
    const boardId = c.req.param('id')
    const role = v.inviteRole((await body(c)).role)
    await requireRole(db, boardId, c.get('user').id, ['owner'])
    const { rows } = await db.query(
      `update kanban.board_members set role = $3 where board_id = $1 and user_id = $2 and role <> 'owner' returning 1`,
      [boardId, c.req.param('userId'), role],
    )
    if (!rows[0]) fail(404, 'Member not found')
    return c.json({ ok: true })
  })

  // The owner removes someone, or a member removes themselves (leaving the board).
  app.delete('/boards/:id/members/:userId', async (c) => {
    const boardId = c.req.param('id')
    const me = c.get('user').id
    const target = c.req.param('userId')
    const myRole = await requireRole(db, boardId, me, ['owner', 'editor', 'viewer'])
    if (target !== me && myRole !== 'owner') fail(403, 'Only the owner can remove people')
    if (target === me && myRole === 'owner') fail(400, 'The owner cannot leave. Delete the board instead.')
    await db.query(`delete from kanban.board_members where board_id = $1 and user_id = $2 and role <> 'owner'`, [
      boardId,
      target,
    ])
    return c.json({ ok: true })
  })

  // --- Invites ---

  app.get('/boards/:id/invites', async (c) => {
    const boardId = c.req.param('id')
    await requireRole(db, boardId, c.get('user').id, ['owner'])
    const { rows } = await db.query(
      'select id, role, email, token from kanban.board_invites where board_id = $1 order by created_at',
      [boardId],
    )
    return c.json(rows)
  })

  app.post('/boards/:id/invites', async (c) => {
    const boardId = c.req.param('id')
    const b = await body(c)
    const role = v.inviteRole(b.role)
    const userId = c.get('user').id
    await requireRole(db, boardId, userId, ['owner'])
    if (b.link === true) {
      const token = newToken()
      await db.query('insert into kanban.board_invites (board_id, token, role, invited_by) values ($1, $2, $3, $4)', [
        boardId,
        token,
        role,
        userId,
      ])
      return c.json({ token })
    }
    const email = v.email(b.email)
    const { rows } = await db.query(
      `insert into kanban.board_invites (board_id, email, role, invited_by) values ($1, $2, $3, $4)
       on conflict (board_id, lower(email)) where email is not null do nothing returning id`,
      [boardId, email, role, userId],
    )
    if (!rows[0]) fail(409, 'That person is already invited')
    return c.json({ ok: true })
  })

  app.delete('/invites/:id', async (c) => {
    const { rows } = await db.query<{ board_id: string }>('select board_id from kanban.board_invites where id = $1', [
      v.uuid(c.req.param('id')),
    ])
    if (!rows[0]) return c.json({ ok: true })
    await requireRole(db, rows[0].board_id, c.get('user').id, ['owner'])
    await db.query('delete from kanban.board_invites where id = $1', [c.req.param('id')])
    return c.json({ ok: true })
  })

  app.get('/invites', async (c) => {
    const { rows } = await db.query(
      `select i.id, i.board_id as "boardId", b.title as "boardTitle", i.role, u.email as "invitedBy"
       from kanban.board_invites i
       join kanban.boards b on b.id = i.board_id
       join kanban.users u on u.id = i.invited_by
       where i.email is not null and lower(i.email) = lower($1)
       order by i.created_at`,
      [c.get('user').email],
    )
    return c.json(rows)
  })

  app.post('/invites/:id/accept', async (c) => {
    const user = c.get('user')
    const boardId = await db.transaction(async (tx) => {
      const { rows } = await tx.query<{ board_id: string; role: Role }>(
        `delete from kanban.board_invites where id = $1 and email is not null and lower(email) = lower($2)
         returning board_id, role`,
        [v.uuid(c.req.param('id')), user.email],
      )
      if (!rows[0]) fail(404, 'Invitation not found')
      await tx.query(
        `insert into kanban.board_members (board_id, user_id, role) values ($1, $2, $3)
         on conflict (board_id, user_id) do nothing`,
        [rows[0].board_id, user.id, rows[0].role],
      )
      return rows[0].board_id
    })
    return c.json({ boardId })
  })

  app.post('/invites/:id/decline', async (c) => {
    await db.query(
      'delete from kanban.board_invites where id = $1 and email is not null and lower(email) = lower($2)',
      [v.uuid(c.req.param('id')), c.get('user').email],
    )
    return c.json({ ok: true })
  })

  app.post('/join', async (c) => {
    const token = (await body(c)).token
    if (typeof token !== 'string' || !token) fail(400, 'Missing invite token')
    const { rows } = await db.query<{ board_id: string; role: Role }>(
      'select board_id, role from kanban.board_invites where token = $1',
      [token],
    )
    if (!rows[0]) fail(404, 'This invite link is no longer valid')
    await db.query(
      `insert into kanban.board_members (board_id, user_id, role) values ($1, $2, $3)
       on conflict (board_id, user_id) do nothing`,
      [rows[0].board_id, c.get('user').id, rows[0].role],
    )
    return c.json({ boardId: rows[0].board_id })
  })

  // --- Live updates (Server-Sent Events) ---

  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const stop = events.add({
        userId: c.get('user').id,
        send: (event) => void stream.writeSSE({ data: JSON.stringify(event) }),
      })
      stream.onAbort(stop)
      await stream.writeSSE({ event: 'ready', data: '{}' })
      // Keep the connection open, with a heartbeat so proxies don't close it.
      while (!stream.aborted) {
        await stream.sleep(25_000)
        if (!stream.aborted) await stream.writeSSE({ event: 'ping', data: '{}' })
      }
      stop()
    }),
  )

  return app
}
