import type { Role } from '../types'
import type { ApiKey, CloudApi, ConnectedApp, CloudUser, SentInvite } from './api'
import { boardRow, cardRows, columnRows, docFromRows, type BoardRow, type CardRow, type ColumnRow } from './doc'

interface Invite extends SentInvite {
  boardId: string
  invitedBy: string
}

/**
 * An in-memory stand-in for the server (server/), with the same access rules.
 * Several users can share one server, which is how the tests exercise sharing.
 */
export class MemoryServer {
  users = new Map<string, CloudUser>()
  boards = new Map<string, BoardRow & { updatedAt: string }>()
  columns = new Map<string, ColumnRow>()
  cards = new Map<string, CardRow>()
  members: { boardId: string; userId: string; role: Role }[] = []
  invites: Invite[] = []
  apiKeys: (ApiKey & { userId: string; key: string })[] = []
  connectedApps: (ConnectedApp & { userId: string })[] = []
  private listeners = new Set<{ userId: string; onBoard: (id: string) => void; onMembership: () => void }>()
  private clock = 0
  private nextId = 1

  passwords = new Map<string, string>()

  addUser(email: string, password = 'password123'): CloudUser {
    const user = { id: `user-${this.nextId++}`, email }
    this.users.set(user.id, user)
    this.passwords.set(user.id, password)
    return user
  }

  /** An API client signed in as this user (or signed out, with null). */
  client(user: CloudUser | null): CloudApi & { setUser(user: CloudUser | null): void } {
    return memoryClient(this, user)
  }

  role(boardId: string, userId: string | undefined): Role | undefined {
    return this.members.find((m) => m.boardId === boardId && m.userId === userId)?.role
  }

  touch(boardId: string) {
    const board = this.boards.get(boardId)
    if (!board) return
    board.updatedAt = `t${++this.clock}`
    for (const l of this.listeners) if (this.role(boardId, l.userId)) l.onBoard(boardId)
  }

  membershipChanged(userId: string) {
    for (const l of this.listeners) if (l.userId === userId) l.onMembership()
  }

  listen(listener: { userId: string; onBoard: (id: string) => void; onMembership: () => void }) {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  token() {
    return `token-${this.nextId++}`
  }
}

function memoryClient(server: MemoryServer, initial: CloudUser | null) {
  let user = initial
  const authListeners = new Set<(user: CloudUser | null) => void>()
  const me = () => {
    if (!user) throw new Error('Not signed in')
    return user
  }
  const canEdit = (boardId: string) => {
    const role = server.role(boardId, user?.id)
    if (role !== 'owner' && role !== 'editor') throw new Error('Permission denied')
  }
  const isOwner = (boardId: string) => {
    if (server.role(boardId, user?.id) !== 'owner') throw new Error('Permission denied')
  }
  const join = (boardId: string, role: Role) => {
    const userId = me().id
    if (!server.role(boardId, userId)) server.members.push({ boardId, userId, role })
    server.membershipChanged(userId)
  }

  const api: CloudApi & { setUser(user: CloudUser | null): void } = {
    setUser(next) {
      user = next
      for (const l of authListeners) l(user)
    },
    async getUser() {
      return user
    },
    onAuthChange(listener) {
      authListeners.add(listener)
      return () => void authListeners.delete(listener)
    },
    async signIn(email, password) {
      const found = [...server.users.values()].find((u) => u.email === email.trim().toLowerCase())
      if (!found || server.passwords.get(found.id) !== password) throw new Error('Wrong email or password')
      api.setUser(found)
    },
    async signUp(email, password) {
      const normalized = email.trim().toLowerCase()
      if ([...server.users.values()].some((u) => u.email === normalized)) {
        throw new Error('An account with this email already exists. Sign in instead.')
      }
      if (password.length < 8) throw new Error('Use a password of at least 8 characters')
      api.setUser(server.addUser(normalized, password))
    },
    async signOut() {
      api.setUser(null)
    },

    async listBoards() {
      const userId = me().id
      return server.members
        .filter((m) => m.userId === userId)
        .map((m) => ({ id: m.boardId, role: m.role, updatedAt: server.boards.get(m.boardId)!.updatedAt }))
    },
    async fetchBoard(boardId) {
      const board = server.boards.get(boardId)
      if (!board || !server.role(boardId, user?.id)) return null
      const columns = [...server.columns.values()].filter((c) => c.board_id === boardId)
      const cards = [...server.cards.values()].filter((c) => c.board_id === boardId)
      return structuredClone(docFromRows(board, columns, cards))
    },
    async createBoard(doc) {
      const userId = me().id
      if (server.boards.has(doc.board.id)) throw new Error('duplicate key')
      server.boards.set(doc.board.id, { ...structuredClone(boardRow(doc)), updatedAt: 't0' })
      server.members.push({ boardId: doc.board.id, userId, role: 'owner' })
      for (const row of columnRows(doc)) server.columns.set(row.id, structuredClone(row))
      for (const row of cardRows(doc)) server.cards.set(row.id, structuredClone(row))
      server.touch(doc.board.id)
    },
    async applyOps(boardId, ops) {
      canEdit(boardId)
      const board = server.boards.get(boardId)!
      if (ops.board) Object.assign(board, structuredClone(ops.board))
      for (const row of ops.upsertColumns) server.columns.set(row.id, structuredClone(row))
      for (const row of ops.upsertCards) {
        // Like the server: a row without progress (from an older app) keeps the progress already stored.
        const previous = server.cards.get(row.id)
        const progress =
          row.progress === undefined
            ? { progress: previous?.progress ?? null, progress_log: previous?.progress_log ?? [] }
            : {}
        server.cards.set(row.id, structuredClone({ ...row, ...progress }))
      }
      for (const id of ops.deleteCardIds) server.cards.delete(id)
      for (const id of ops.deleteColumnIds) {
        server.columns.delete(id)
        for (const [cardId, card] of server.cards) if (card.column_id === id) server.cards.delete(cardId)
      }
      server.touch(boardId)
    },
    async deleteBoard(boardId) {
      isOwner(boardId)
      const affected = server.members.filter((m) => m.boardId === boardId).map((m) => m.userId)
      server.boards.delete(boardId)
      server.members = server.members.filter((m) => m.boardId !== boardId)
      server.invites = server.invites.filter((i) => i.boardId !== boardId)
      for (const [id, c] of server.columns) if (c.board_id === boardId) server.columns.delete(id)
      for (const [id, c] of server.cards) if (c.board_id === boardId) server.cards.delete(id)
      for (const userId of affected) server.membershipChanged(userId)
    },

    async listMembers(boardId) {
      if (!server.role(boardId, user?.id)) return []
      return server.members
        .filter((m) => m.boardId === boardId)
        .map((m) => ({ userId: m.userId, role: m.role, email: server.users.get(m.userId)?.email ?? '' }))
    },
    async setMemberRole(boardId, userId, role) {
      isOwner(boardId)
      const member = server.members.find((m) => m.boardId === boardId && m.userId === userId)
      if (!member || member.role === 'owner') throw new Error('Permission denied')
      member.role = role
      server.membershipChanged(userId)
    },
    async removeMember(boardId, userId) {
      isOwner(boardId)
      server.members = server.members.filter(
        (m) => !(m.boardId === boardId && m.userId === userId && m.role !== 'owner'),
      )
      server.membershipChanged(userId)
    },
    async leaveBoard(boardId) {
      const userId = me().id
      if (server.role(boardId, userId) === 'owner') throw new Error('The owner cannot leave')
      server.members = server.members.filter((m) => !(m.boardId === boardId && m.userId === userId))
      server.membershipChanged(userId)
    },

    async listSentInvites(boardId) {
      if (server.role(boardId, user?.id) !== 'owner') return []
      return server.invites
        .filter((i) => i.boardId === boardId)
        .map(({ id, role, email, token }) => ({ id, role, email, token }))
    },
    async inviteByEmail(boardId, email, role) {
      isOwner(boardId)
      const normalized = email.trim().toLowerCase()
      if (server.invites.some((i) => i.boardId === boardId && i.email === normalized)) {
        throw new Error('That person is already invited')
      }
      server.invites.push({ id: server.token(), boardId, email: normalized, token: null, role, invitedBy: me().id })
    },
    async createInviteLink(boardId, role) {
      isOwner(boardId)
      const token = server.token()
      server.invites.push({ id: server.token(), boardId, email: null, token, role, invitedBy: me().id })
      return token
    },
    async revokeInvite(inviteId) {
      const invite = server.invites.find((i) => i.id === inviteId)
      if (invite) isOwner(invite.boardId)
      server.invites = server.invites.filter((i) => i.id !== inviteId)
    },

    async listReceivedInvites() {
      const email = me().email.toLowerCase()
      return server.invites
        .filter((i) => i.email === email)
        .map((i) => ({
          id: i.id,
          boardId: i.boardId,
          boardTitle: server.boards.get(i.boardId)?.title ?? '',
          role: i.role,
          invitedBy: server.users.get(i.invitedBy)?.email ?? '',
        }))
    },
    async acceptInvite(inviteId) {
      const invite = server.invites.find((i) => i.id === inviteId && i.email === me().email.toLowerCase())
      if (!invite) throw new Error('Invitation not found')
      server.invites = server.invites.filter((i) => i !== invite)
      join(invite.boardId, invite.role)
      return invite.boardId
    },
    async declineInvite(inviteId) {
      const email = me().email.toLowerCase()
      server.invites = server.invites.filter((i) => !(i.id === inviteId && i.email === email))
    },
    async joinWithLink(token) {
      const invite = server.invites.find((i) => i.token === token)
      if (!invite) throw new Error('This invite link is no longer valid')
      join(invite.boardId, invite.role)
      return invite.boardId
    },

    async listApiKeys() {
      const userId = me().id
      return server.apiKeys
        .filter((k) => k.userId === userId)
        .map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt }))
    },
    async createApiKey(name) {
      if (!name.trim()) throw new Error('name is required')
      const created = {
        id: server.token(),
        name: name.trim(),
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        key: `kbn_${server.token()}`,
      }
      server.apiKeys.push({ ...created, userId: me().id })
      return created
    },
    async listConnectedApps() {
      const userId = me().id
      return server.connectedApps
        .filter((a) => a.userId === userId)
        .map(({ id, name, connectedAt, lastUsedAt }) => ({ id, name, connectedAt, lastUsedAt }))
    },
    async disconnectApp(appId) {
      const userId = me().id
      server.connectedApps = server.connectedApps.filter((a) => !(a.id === appId && a.userId === userId))
    },
    async revokeApiKey(keyId) {
      const userId = me().id
      server.apiKeys = server.apiKeys.filter((k) => !(k.id === keyId && k.userId === userId))
    },

    subscribe(userId, handlers) {
      return server.listen({ userId, ...handlers })
    },
  }
  return api
}
