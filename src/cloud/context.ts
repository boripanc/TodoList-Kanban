import { createContext, useContext } from 'react'
import type { Action } from '../state/reducer'
import type { AssignmentRequest, Attachment, CloudApi, CloudUser, ReceivedInvite } from './api'

export interface Cloud {
  api: CloudApi
  /** Undefined while the session is loading. */
  user: CloudUser | null | undefined
  invites: ReceivedInvite[]
  /** An invite link was opened while signed out; sign-in is needed to join. */
  pendingJoin: boolean
  error: string | null
  clearError: () => void
  reportError: (error: unknown) => void
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  /** Create a board in the user's account. */
  createBoard: (action: Extract<Action, { type: 'board/add' }>) => void
  /** Move a board from this device to the user's account so it can be shared. */
  moveToAccount: (boardId: string) => void
  deleteBoard: (boardId: string) => void
  leaveBoard: (boardId: string) => Promise<void>
  acceptInvite: (inviteId: string) => Promise<void>
  declineInvite: (inviteId: string) => Promise<void>
  /** Assignments on the current board that wait for its owner (asked for through MCP), oldest first. */
  assignmentRequests: AssignmentRequest[]
  /** Owner only: give the card the requested assignees. */
  approveAssignment: (cardId: string) => Promise<void>
  /** Owner only: turn the request down; the card stays as it is. */
  rejectAssignment: (cardId: string) => Promise<void>
  /** Files on the current board's cards, oldest first. */
  attachments: Attachment[]
  /** Attach a file to a card on the current board (editors and owners). */
  addAttachment: (cardId: string, file: File) => Promise<void>
  deleteAttachment: (attachmentId: string) => Promise<void>
  /** Resolves once changes made so far have reached the server. */
  saved: () => Promise<void>
  /** Reload boards and invitations from the server. */
  refresh: () => Promise<void>
}

export const CloudContext = createContext<Cloud | null>(null)

/** The account and sharing features, or null when no backend is configured. */
export function useCloud(): Cloud | null {
  return useContext(CloudContext)
}
