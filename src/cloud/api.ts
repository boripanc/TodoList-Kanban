import type { Role } from '../types'
import type { CredentialKind } from '../lib/credentials'
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

/**
 * An assignment an AI agent or automation asked for through MCP. It waits for
 * the board owner to approve it; until then the card keeps its assignees.
 */
export interface AssignmentRequest {
  cardId: string
  /** Who the card would be assigned to; id is null for a name that joins the team on approval. [] unassigns everyone. */
  assignees: { id: string | null; name: string }[]
  /** Email of the account whose API key or connected app asked. */
  requestedBy: string | null
  requestedAt: string
}

/** A file attached to a card, e.g. an interface spec in Word or Excel. */
export interface Attachment {
  id: string
  cardId: string
  name: string
  type: string
  size: number
  /** Email of who added it, or null when their account is gone. */
  uploadedBy: string | null
  uploadedAt: string
}

/** An API key, for automation tools such as n8n. The key itself is only shown once, on creation. */
export interface ApiKey {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
}

/** An app, such as Claude, that the user allowed to use their boards by signing in (OAuth). */
export interface ConnectedApp {
  id: string
  name: string
  connectedAt: string
  lastUsedAt: string | null
}

/** A person in the user's own address book. */
export interface Contact {
  id: string
  name: string
  company: string
  jobTitle: string
  email: string
  phone: string
  website: string
  address: string
  notes: string
  createdAt: string
  updatedAt: string
}

export type ContactInput = Omit<Contact, 'id' | 'createdAt' | 'updatedAt'>

/** One field of a credential. Secret values are encrypted on the server and left out (null) of lists. */
export interface CredentialField {
  name: string
  value: string | null
  secret: boolean
  multiline: boolean
}

/** A saved credential, without its secret values. */
export interface Credential {
  id: string
  name: string
  kind: CredentialKind
  url: string
  fields: CredentialField[]
  createdAt: string
  updatedAt: string
}

/**
 * A credential to save. On an update, a secret field with a null value and null notes
 * keep what was saved before, so the secrets don't have to be opened to edit the rest.
 */
export interface CredentialInput {
  name: string
  kind: CredentialKind
  url: string
  notes: string | null
  fields: CredentialField[]
}

/** A credential's secret values, by field name, and its notes. */
export interface CredentialSecrets {
  fields: Record<string, string>
  notes: string
}

/**
 * Where the key that encrypts credentials comes from: the server's CREDENTIALS_KEY setting,
 * or (without one) a key the server generated and keeps in the database.
 */
export type VaultKeySource = 'env' | 'database'

/** Everything the app needs from the backend. The app's own server in production, in memory in tests. */
export interface CloudApi {
  getUser(): Promise<CloudUser | null>
  onAuthChange(listener: (user: CloudUser | null) => void): () => void
  signIn(email: string, password: string): Promise<void>
  /** Create an account and sign in to it. */
  signUp(email: string, password: string): Promise<void>
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

  /** Assignments on a board waiting for its owner, oldest first. */
  listAssignmentRequests(boardId: string): Promise<AssignmentRequest[]>
  /** Owner only: the card gets the requested assignees. */
  approveAssignment(boardId: string, cardId: string): Promise<void>
  /** Owner only: the request goes away and the card stays as it is. */
  rejectAssignment(boardId: string, cardId: string): Promise<void>

  /** Files on every card of a board, oldest first. */
  listAttachments(boardId: string): Promise<Attachment[]>
  /** Editors and owners: attach a file (contents as base64) to a card. */
  addAttachment(cardId: string, file: { name: string; data: string }): Promise<Attachment>
  deleteAttachment(attachmentId: string): Promise<void>
  /** Where the browser downloads a file from. */
  attachmentUrl(attachmentId: string): string

  listApiKeys(): Promise<ApiKey[]>
  /** Returns the new key's details and the secret key, which can't be read again later. */
  createApiKey(name: string): Promise<ApiKey & { key: string }>
  revokeApiKey(keyId: string): Promise<void>
  listConnectedApps(): Promise<ConnectedApp[]>
  /** Its access stops right away. */
  disconnectApp(appId: string): Promise<void>

  listContacts(): Promise<Contact[]>
  createContact(contact: ContactInput): Promise<Contact>
  updateContact(contactId: string, contact: ContactInput): Promise<Contact>
  deleteContact(contactId: string): Promise<void>

  listCredentials(): Promise<{ credentials: Credential[]; keySource: VaultKeySource }>
  createCredential(credential: CredentialInput): Promise<Credential>
  updateCredential(credentialId: string, credential: CredentialInput): Promise<Credential>
  /** The secret values, decrypted. Only with a signed-in session, never with an API key. */
  revealCredential(credentialId: string): Promise<CredentialSecrets>
  deleteCredential(credentialId: string): Promise<void>

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
