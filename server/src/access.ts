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
