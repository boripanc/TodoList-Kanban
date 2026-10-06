import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import type { Role } from '../types'
import type { CloudApi, CloudUser, Member, ReceivedInvite, SentInvite } from './api'
import { boardRow, cardRows, columnRows, docFromRows, type BoardRow, type CardRow, type ColumnRow } from './doc'

function toUser(user: User | null | undefined): CloudUser | null {
  return user ? { id: user.id, email: user.email ?? '' } : null
}

/** Unwrap a Supabase response, turning its error into a thrown Error. */
function check<T>(result: { data?: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message)
  return result.data as T
}

export function createSupabaseApi(url: string, anonKey: string): CloudApi {
  const sb: SupabaseClient = createClient(url, anonKey)

  return {
    async getUser() {
      const { data } = await sb.auth.getSession()
      return toUser(data.session?.user)
    },

    onAuthChange(listener) {
      const { data } = sb.auth.onAuthStateChange((_event, session) => listener(toUser(session?.user)))
      return () => data.subscription.unsubscribe()
    },

    async signIn(email) {
      const redirect = window.location.origin + window.location.pathname
      check(await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect } }))
    },

    async signOut() {
      check(await sb.auth.signOut())
    },

    async listBoards() {
      const { data: auth } = await sb.auth.getSession()
      const userId = auth.session?.user.id
      if (!userId) return []
      const rows = check(
        await sb.from('board_members').select('role, boards(id, updated_at)').eq('user_id', userId),
      ) as unknown as { role: Role; boards: { id: string; updated_at: string } | null }[]
      return rows.flatMap((row) =>
        row.boards ? [{ id: row.boards.id, role: row.role, updatedAt: row.boards.updated_at }] : [],
      )
    },

    async fetchBoard(boardId) {
      const [board, columns, cards] = await Promise.all([
        sb.from('boards').select('id, title, labels, created_at').eq('id', boardId).maybeSingle(),
        sb.from('columns').select('id, board_id, position, title, wip_limit').eq('board_id', boardId),
        sb.from('cards').select('*').eq('board_id', boardId),
      ])
      const row = check(board) as BoardRow | null
      if (!row) return null
      return docFromRows(row, check(columns) as ColumnRow[], (check(cards) as CardRow[]).map(cardFromDb))
    },

    async createBoard(doc) {
      check(await sb.from('boards').insert(boardRow(doc)))
      const columns = columnRows(doc)
      if (columns.length) check(await sb.from('columns').insert(columns))
      const cards = cardRows(doc)
      if (cards.length) check(await sb.from('cards').insert(cards))
    },

    async applyOps(boardId, ops) {
      // Order matters: columns exist before cards move into them; cards go before their columns.
      if (ops.board) check(await sb.from('boards').update(ops.board).eq('id', boardId))
      if (ops.upsertColumns.length) check(await sb.from('columns').upsert(ops.upsertColumns))
      if (ops.upsertCards.length) check(await sb.from('cards').upsert(ops.upsertCards))
      if (ops.deleteCardIds.length) check(await sb.from('cards').delete().in('id', ops.deleteCardIds))
      if (ops.deleteColumnIds.length) check(await sb.from('columns').delete().in('id', ops.deleteColumnIds))
    },

    async deleteBoard(boardId) {
      check(await sb.from('boards').delete().eq('id', boardId))
    },

    async listMembers(boardId) {
      const rows = check(
        await sb.from('board_members').select('user_id, role, profiles(email)').eq('board_id', boardId),
      ) as unknown as { user_id: string; role: Role; profiles: { email: string } | null }[]
      const order: Record<Role, number> = { owner: 0, editor: 1, viewer: 2 }
      return rows
        .map((row): Member => ({ userId: row.user_id, role: row.role, email: row.profiles?.email ?? '' }))
        .sort((a, b) => order[a.role] - order[b.role] || a.email.localeCompare(b.email))
    },

    async setMemberRole(boardId, userId, role) {
      check(await sb.from('board_members').update({ role }).eq('board_id', boardId).eq('user_id', userId))
    },

    async removeMember(boardId, userId) {
      check(await sb.from('board_members').delete().eq('board_id', boardId).eq('user_id', userId))
    },

    async leaveBoard(boardId) {
      const { data: auth } = await sb.auth.getSession()
      const userId = auth.session?.user.id
      if (!userId) throw new Error('Not signed in')
      check(await sb.from('board_members').delete().eq('board_id', boardId).eq('user_id', userId))
    },

    async listSentInvites(boardId) {
      const rows = check(
        await sb.from('board_invites').select('id, role, email, token').eq('board_id', boardId).order('created_at'),
      )
      return rows as SentInvite[]
    },

    async inviteByEmail(boardId, email, role) {
      check(await sb.from('board_invites').insert({ board_id: boardId, email: email.trim().toLowerCase(), role }))
    },

    async createInviteLink(boardId, role) {
      return check(await sb.rpc('create_invite_link', { p_board: boardId, p_role: role })) as string
    },

    async revokeInvite(inviteId) {
      check(await sb.from('board_invites').delete().eq('id', inviteId))
    },

    async listReceivedInvites() {
      const rows = check(await sb.rpc('my_invites')) as {
        id: string
        board_id: string
        board_title: string
        role: Exclude<Role, 'owner'>
        invited_by_email: string
      }[]
      return rows.map(
        (row): ReceivedInvite => ({
          id: row.id,
          boardId: row.board_id,
          boardTitle: row.board_title,
          role: row.role,
          invitedBy: row.invited_by_email,
        }),
      )
    },

    async acceptInvite(inviteId) {
      return check(await sb.rpc('accept_invite', { p_invite: inviteId })) as string
    },

    async declineInvite(inviteId) {
      check(await sb.rpc('decline_invite', { p_invite: inviteId }))
    },

    async joinWithLink(token) {
      return check(await sb.rpc('join_board_with_link', { p_token: token })) as string
    },

    subscribe(userId, { onBoard, onMembership }) {
      // Realtime only delivers rows this user may read, so no board filter is needed.
      const channel = sb
        .channel(`kanban-${userId}`)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'boards' }, (payload) => {
          const id = (payload.new as { id?: string }).id
          if (id) onBoard(id)
        })
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'board_members', filter: `user_id=eq.${userId}` },
          () => onMembership(),
        )
        .subscribe()
      return () => {
        void sb.removeChannel(channel)
      }
    },
  }
}

function cardFromDb(row: CardRow): CardRow {
  return { ...row, label_ids: row.label_ids ?? [], checklist: row.checklist ?? [] }
}
