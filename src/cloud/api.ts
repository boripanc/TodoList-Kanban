import type { Role } from '../types'
import type { BoardDoc, BoardOps, BoardSummary } from './doc'

export interface CloudUser {
  id: string
  email: string
}

export interface Member {
  userId: string
  email: string
  role: Role
}

/** An invite the board owner sent: to an email address, or as a shareable link. */
export interface SentInvite {
  id: string
  role: Exclude<Role, 'owner'>
  email: string | null
  token: string | null
}

/** An invite waiting for the signed-in user. */
export interface ReceivedInvite {
  id: string
  boardId: string
  boardTitle: string
  role: Exclude<Role, 'owner'>
  invitedBy: string
}

/** Everything the app needs from the backend. Supabase in production, in memory in tests. */
export interface CloudApi {
  getUser(): Promise<CloudUser | null>
  onAuthChange(listener: (user: CloudUser | null) => void): () => void
  /** Send a sign-in link to this email address. */
  signIn(email: string): Promise<void>
  signOut(): Promise<void>

  listBoards(): Promise<BoardSummary[]>
  /** Null when the board is gone or the user no longer has access. */
  fetchBoard(boardId: string): Promise<BoardDoc | null>
  createBoard(doc: BoardDoc): Promise<void>
  applyOps(boardId: string, ops: BoardOps): Promise<void>
  deleteBoard(boardId: string): Promise<void>

  listMembers(boardId: string): Promise<Member[]>
  setMemberRole(boardId: string, userId: string, role: Exclude<Role, 'owner'>): Promise<void>
  removeMember(boardId: string, userId: string): Promise<void>
  leaveBoard(boardId: string): Promise<void>

  listSentInvites(boardId: string): Promise<SentInvite[]>
  inviteByEmail(boardId: string, email: string, role: Exclude<Role, 'owner'>): Promise<void>
  /** Returns the link token. */
  createInviteLink(boardId: string, role: Exclude<Role, 'owner'>): Promise<string>
  revokeInvite(inviteId: string): Promise<void>

  listReceivedInvites(): Promise<ReceivedInvite[]>
  /** Returns the board id. */
  acceptInvite(inviteId: string): Promise<string>
  declineInvite(inviteId: string): Promise<void>
  /** Returns the board id. */
  joinWithLink(token: string): Promise<string>

  /**
   * Listen for changes made elsewhere: `onBoard` when a board's content changes,
   * `onMembership` when the user gains, loses or changes access to a board.
   */
  subscribe(userId: string, handlers: { onBoard: (boardId: string) => void; onMembership: () => void }): () => void
}

export const roleName: Record<Role, string> = { owner: 'Owner', editor: 'Can edit', viewer: 'Can view' }

export function inviteLink(token: string, base = window.location.origin + window.location.pathname): string {
  return `${base}?join=${encodeURIComponent(token)}`
}
