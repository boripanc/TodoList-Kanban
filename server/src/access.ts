import { HTTPException } from 'hono/http-exception'
import type { Queryable } from './db.ts'

export type Role = 'owner' | 'editor' | 'viewer'
export type User = { id: string; email: string }

export const fail = (status: 400 | 401 | 403 | 404 | 409 | 429, message: string): never => {
  throw new HTTPException(status, { message })
}

export async function roleOf(q: Queryable, boardId: string, userId: string): Promise<Role | undefined> {
  const { rows } = await q.query<{ role: Role }>(
    'select role from kanban.board_members where board_id = $1 and user_id = $2',
    [boardId, userId],
  )
  return rows[0]?.role
}

/** The caller's role on the board, refusing with 404 (no access) or 403 (role not allowed). */
export async function requireRole(q: Queryable, boardId: string, userId: string, allowed: Role[]) {
  const role = await roleOf(q, boardId, userId)
  if (!role) fail(404, 'Board not found')
  if (!allowed.includes(role!)) fail(403, 'You do not have permission to do that')
  return role!
}

export const canRead: Role[] = ['owner', 'editor', 'viewer']
export const canEdit: Role[] = ['owner', 'editor']

/**
 * The caller's role on a team: its owner; an editor when they can change any
 * of its boards; a viewer when they can only see one of them.
 */
export async function teamRoleOf(q: Queryable, teamId: string, userId: string): Promise<Role | undefined> {
  const { rows } = await q.query<{ owner: boolean; edits: boolean | null; sees: boolean | null }>(
    `select t.owner_id = $2 as owner,
       (select bool_or(m.role in ('owner', 'editor')) from kanban.board_members m join kanban.boards b on b.id = m.board_id
        where b.team_id = t.id and m.user_id = $2) as edits,
       (select count(*) > 0 from kanban.board_members m join kanban.boards b on b.id = m.board_id
        where b.team_id = t.id and m.user_id = $2) as sees
     from kanban.teams t where t.id = $1`,
    [teamId, userId],
  )
  const row = rows[0]
  if (!row) return undefined
  if (row.owner) return 'owner'
  if (row.edits) return 'editor'
  return row.sees ? 'viewer' : undefined
}

/** The caller's role on the team, refusing with 404 (can't see it) or 403 (role not allowed). */
export async function requireTeamRole(q: Queryable, teamId: string, userId: string, allowed: Role[]) {
  const role = await teamRoleOf(q, teamId, userId)
  if (!role) fail(404, 'Team not found')
  if (!allowed.includes(role!)) fail(403, 'You do not have permission to do that')
  return role!
}
