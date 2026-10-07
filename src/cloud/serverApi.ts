import type { ApiToken, CloudApi, CloudUser, Member, ReceivedInvite, SentInvite } from './api'
import { boardRow, cardRows, columnRows, docFromRows, type BoardRow, type CardRow, type ColumnRow } from './doc'

/** No answer from the server yet: it may still be starting. */
export class UnreachableError extends Error {}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Talks to the app's own server (server/), which keeps accounts and shared boards in Postgres. */
export function createServerApi(base: string): CloudApi {
  const root = base.replace(/\/$/, '')
  let user: CloudUser | null = null
  const listeners = new Set<(user: CloudUser | null) => void>()
  const setUser = (next: CloudUser | null) => {
    if (next?.id === user?.id) return
    user = next
    for (const l of listeners) l(user)
  }

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await fetch(root + path, {
        method,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      })
    } catch {
      throw new UnreachableError('Could not reach the server. Check your connection.')
    }
    const data = (await res.json().catch(() => ({}))) as T & { error?: string }
    // The dev proxy answers 5xx while the server is still starting.
    if (res.status >= 500 && res.status <= 504 && !data.error) throw new UnreachableError(`The server answered ${res.status}.`)
    if (!res.ok) {
      // The session ended (expired, or signed out elsewhere).
      if (res.status === 401 && !path.startsWith('/auth/')) setUser(null)
      throw new HttpError(res.status, data.error ?? `The server answered ${res.status}.`)
    }
    return data
  }

  const enc = encodeURIComponent

  return {
    async getUser() {
      const data = await call<{ user?: CloudUser | null }>('GET', '/auth/me')
      // A static host answers /api with the app's own page or {}; only the real server says who is signed in.
      if (!data || typeof data !== 'object' || !('user' in data)) throw new Error('The app server is not running.')
      const me = data.user ?? null
      setUser(me)
      return me
    },
    onAuthChange(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    async signIn(email, password) {
      setUser((await call<{ user: CloudUser }>('POST', '/auth/signin', { email, password })).user)
    },
    async signUp(email, password) {
      setUser((await call<{ user: CloudUser }>('POST', '/auth/signup', { email, password })).user)
    },
    async signOut() {
      await call('POST', '/auth/signout')
      setUser(null)
    },

    listBoards: () => call('GET', '/boards'),
    async fetchBoard(boardId) {
      try {
        const doc = await call<{ board: BoardRow; columns: ColumnRow[]; cards: CardRow[] }>(
          'GET',
          `/boards/${enc(boardId)}`,
        )
        return docFromRows(doc.board, doc.columns, doc.cards)
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) return null
        throw error
      }
    },
    async createBoard(doc) {
      await call('POST', '/boards', { board: boardRow(doc), columns: columnRows(doc), cards: cardRows(doc) })
    },
    async applyOps(boardId, ops) {
      await call('POST', `/boards/${enc(boardId)}/changes`, ops)
    },
    async deleteBoard(boardId) {
      await call('DELETE', `/boards/${enc(boardId)}`)
    },

    listMembers: (boardId) => call<Member[]>('GET', `/boards/${enc(boardId)}/members`),
    async setMemberRole(boardId, userId, role) {
      await call('PATCH', `/boards/${enc(boardId)}/members/${enc(userId)}`, { role })
    },
    async removeMember(boardId, userId) {
      await call('DELETE', `/boards/${enc(boardId)}/members/${enc(userId)}`)
    },
    async leaveBoard(boardId) {
      if (!user) throw new Error('Not signed in')
      await call('DELETE', `/boards/${enc(boardId)}/members/${enc(user.id)}`)
    },

    listSentInvites: (boardId) => call<SentInvite[]>('GET', `/boards/${enc(boardId)}/invites`),
    async inviteByEmail(boardId, email, role) {
      await call('POST', `/boards/${enc(boardId)}/invites`, { email, role })
    },
    async createInviteLink(boardId, role) {
      return (await call<{ token: string }>('POST', `/boards/${enc(boardId)}/invites`, { link: true, role })).token
    },
    async revokeInvite(inviteId) {
      await call('DELETE', `/invites/${enc(inviteId)}`)
    },

    listReceivedInvites: () => call<ReceivedInvite[]>('GET', '/invites'),
    async acceptInvite(inviteId) {
      return (await call<{ boardId: string }>('POST', `/invites/${enc(inviteId)}/accept`)).boardId
    },
    async declineInvite(inviteId) {
      await call('POST', `/invites/${enc(inviteId)}/decline`)
    },
    async joinWithLink(token) {
      return (await call<{ boardId: string }>('POST', '/join', { token })).boardId
    },

    listTokens: () => call<ApiToken[]>('GET', '/tokens'),
    createToken: (name) => call<ApiToken & { token: string }>('POST', '/tokens', { name }),
    async revokeToken(tokenId) {
      await call('DELETE', `/tokens/${enc(tokenId)}`)
    },

    subscribe(_userId, { onBoard, onMembership }) {
      // The browser reconnects on its own; after a reconnect, catch up on anything missed.
      const source = new EventSource(`${root}/events`, { withCredentials: true })
      let connectedBefore = false
      source.addEventListener('ready', () => {
        if (connectedBefore) onMembership()
        connectedBefore = true
      })
      source.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data as string) as { type: string; boardId?: string }
          if (event.type === 'board' && event.boardId) onBoard(event.boardId)
          else if (event.type === 'member') onMembership()
        } catch {
          // Ignore anything that isn't an event.
        }
      }
      return () => source.close()
    },
  }
}
