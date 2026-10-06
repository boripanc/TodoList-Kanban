// @vitest-environment node
// Runs the migration in an in-process Postgres (PGlite) with a stub of
// Supabase's auth schema, then checks the access rules as different users.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const migrations = join(import.meta.dirname, '..', 'migrations')

const users = {
  ana: '00000000-0000-4000-8000-00000000000a',
  ben: '00000000-0000-4000-8000-00000000000b',
  cat: '00000000-0000-4000-8000-00000000000c',
  dan: '00000000-0000-4000-8000-00000000000d',
} as const
type User = keyof typeof users

const authStub = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  grant usage on schema auth to anon, authenticated;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant execute on function auth.uid() to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  create publication supabase_realtime;
`

let db: PGlite

// Each test runs in a transaction that is rolled back; each statement gets a
// savepoint so an expected failure doesn't abort the rest of the test.
async function as<T>(user: User, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec(
    `savepoint step; select set_config('request.jwt.claim.sub', '${users[user]}', true); set local role authenticated;`,
  )
  try {
    const rows = (await db.query<T>(sql, params)).rows
    await db.exec('reset role; release savepoint step')
    return rows
  } catch (error) {
    await db.exec('rollback to savepoint step; reset role; release savepoint step')
    throw error
  }
}

async function fails(user: User, sql: string, params: unknown[] = []) {
  await expect(as(user, sql, params)).rejects.toThrow()
}

async function createBoard(user: User, id: string) {
  await as(user, `insert into boards (id, title, created_at) values ($1, 'Board ' || $1, 0)`, [id])
  await as(user, `insert into columns (id, board_id, position, title) values ($1 || '-todo', $1, 0, 'To do')`, [id])
  await as(
    user,
    `insert into cards (id, board_id, column_id, position, title, created_at, updated_at)
     values ($1 || '-card', $1, $1 || '-todo', 0, 'Secret task', 0, 0)`,
    [id],
  )
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(authStub)
  for (const file of readdirSync(migrations).sort()) {
    await db.exec(readFileSync(join(migrations, file), 'utf8'))
  }
  for (const [name, id] of Object.entries(users)) {
    await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `${name}@example.com`])
  }
}, 30_000)

beforeEach(async () => {
  await db.exec('begin')
  await createBoard('ana', 'b1')
})

afterEach(async () => {
  await db.exec('rollback')
})

describe('boards', () => {
  it('makes the creator the owner and hides the board from others', async () => {
    expect(await as('ana', 'select role from board_members where board_id = $1', ['b1'])).toEqual([{ role: 'owner' }])
    expect(await as('ben', 'select * from boards')).toEqual([])
    expect(await as('ben', 'select * from cards')).toEqual([])
    await as('ben', `update cards set title = 'hacked'`)
    expect(await as('ana', 'select title from cards')).toEqual([{ title: 'Secret task' }])
  })

  it('does not let anyone create a board owned by someone else', async () => {
    await fails('ben', `insert into boards (id, owner_id, title, created_at) values ('b2', $1, 'x', 0)`, [users.ana])
  })

  it('does not let a card point at a column on another board', async () => {
    await createBoard('ben', 'b2')
    await fails(
      'ben',
      `insert into cards (id, board_id, column_id, position, title, created_at, updated_at)
       values ('x', 'b2', 'b1-todo', 0, 'x', 0, 0)`,
    )
  })

  it('bumps updated_at when cards change', async () => {
    const [before] = await as<{ updated_at: Date }>('ana', 'select updated_at from boards')
    await new Promise((r) => setTimeout(r, 5))
    await as('ana', `update cards set title = 'Changed'`)
    const [after] = await as<{ updated_at: Date }>('ana', 'select updated_at from boards')
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime())
  })
})

describe('email invites', () => {
  beforeEach(async () => {
    await as('ana', `insert into board_invites (board_id, email, role) values ('b1', 'BEN@example.com', 'editor')`)
  })

  it('shows the invite to the invitee only, and accepting makes them a member', async () => {
    expect(await as('cat', 'select * from my_invites()')).toEqual([])
    const [invite] = await as<{ id: string; board_title: string; invited_by_email: string }>(
      'ben',
      'select * from my_invites()',
    )
    expect(invite).toMatchObject({ board_title: 'Board b1', invited_by_email: 'ana@example.com' })
    await fails('cat', 'select accept_invite($1)', [invite.id])
    expect(await as('ben', 'select accept_invite($1) as board', [invite.id])).toEqual([{ board: 'b1' }])
    expect(await as('ben', 'select title from cards')).toEqual([{ title: 'Secret task' }])
    await as('ben', `update cards set title = 'Edited by Ben'`)
    expect(await as('ana', 'select title from cards')).toEqual([{ title: 'Edited by Ben' }])
    expect(await as('ben', 'select * from my_invites()')).toEqual([])
  })

  it('lets the invitee decline', async () => {
    const [invite] = await as<{ id: string }>('ben', 'select id from my_invites()')
    await as('ben', 'select decline_invite($1)', [invite.id])
    expect(await as('ana', 'select * from board_invites')).toEqual([])
    expect(await as('ben', 'select * from boards')).toEqual([])
  })

  it('only lets the owner invite', async () => {
    const [invite] = await as<{ id: string }>('ben', 'select id from my_invites()')
    await as('ben', 'select accept_invite($1)', [invite.id])
    await fails('ben', `insert into board_invites (board_id, email, role) values ('b1', 'cat@example.com', 'editor')`)
  })
})

describe('link invites and roles', () => {
  let token: string

  beforeEach(async () => {
    ;[{ token }] = await as<{ token: string }>('ana', `select create_invite_link('b1', 'viewer') as token`)
  })

  it('lets anyone with the link join with the link role', async () => {
    expect(await as('cat', 'select join_board_with_link($1) as board', [token])).toEqual([{ board: 'b1' }])
    expect(await as('cat', 'select role from board_members where user_id = auth.uid()')).toEqual([{ role: 'viewer' }])
    await fails('cat', 'select join_board_with_link($1)', ['not-a-token'])
    await fails('ben', `select create_invite_link('b1', 'editor')`)
  })

  it('keeps viewers read-only', async () => {
    await as('cat', 'select join_board_with_link($1)', [token])
    expect(await as('cat', 'select title from cards')).toHaveLength(1)
    await as('cat', `update cards set title = 'nope'`)
    await as('cat', `delete from cards`)
    await fails(
      'cat',
      `insert into cards (id, board_id, column_id, position, title, created_at, updated_at)
       values ('c2', 'b1', 'b1-todo', 1, 'x', 0, 0)`,
    )
    await as('cat', `update boards set title = 'nope'`)
    expect(await as('ana', 'select title from cards')).toEqual([{ title: 'Secret task' }])
    expect(await as('ana', 'select title from boards')).toEqual([{ title: 'Board b1' }])
  })

  it('lets the owner change roles and remove people, but not themselves', async () => {
    await as('cat', 'select join_board_with_link($1)', [token])
    await as('cat', `update board_members set role = 'owner'`)
    await as('cat', `update board_members set role = 'editor' where user_id = auth.uid()`)
    expect(await as('cat', 'select role from board_members where user_id = auth.uid()')).toEqual([{ role: 'viewer' }])
    await as('ana', `update board_members set role = 'editor' where user_id = $1`, [users.cat])
    expect(await as('cat', 'select role from board_members where user_id = auth.uid()')).toEqual([{ role: 'editor' }])
    await fails('ana', `update board_members set role = 'owner' where user_id = $1`, [users.cat])
    await as('ana', `delete from board_members where user_id = $1`, [users.ana])
    await as('ana', `delete from board_members where user_id = $1`, [users.cat])
    expect(await as('ana', 'select role from board_members')).toEqual([{ role: 'owner' }])
    expect(await as('cat', 'select * from boards')).toEqual([])
  })

  it('lets members leave and see each other, and stops a revoked link', async () => {
    await as('cat', 'select join_board_with_link($1)', [token])
    expect(
      (await as<{ email: string }>('cat', 'select email from profiles order by email')).map((p) => p.email),
    ).toEqual(['ana@example.com', 'cat@example.com'])
    await as('cat', 'delete from board_members where user_id = auth.uid()')
    expect(await as('cat', 'select * from boards')).toEqual([])
    await as('ana', 'delete from board_invites where token = $1', [token])
    await fails('dan', 'select join_board_with_link($1)', [token])
  })

  it('does not let editors delete the board or rewrite its owner', async () => {
    await as('cat', 'select join_board_with_link($1)', [token])
    await as('ana', `update board_members set role = 'editor' where user_id = $1`, [users.cat])
    await fails('cat', `update boards set owner_id = auth.uid()`)
    await as('cat', 'delete from boards')
    expect(await as('ana', 'select id from boards')).toEqual([{ id: 'b1' }])
    await as('ana', 'delete from boards')
    expect(await as('ana', 'select * from cards')).toEqual([])
  })
})
