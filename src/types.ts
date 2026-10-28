export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent'

export interface Label {
  id: string
  name: string
  color: string
}

/** A person cards on a board can be assigned to. */
export interface TeamMember {
  id: string
  name: string
  color: string
  /** How many open cards this person can take on at once; 0 means no limit. */
  capacity: number
}

export interface ChecklistItem {
  id: string
  text: string
  done: boolean
}

export interface ProgressEntry {
  id: string
  /** What was done; may be empty when only the percentage changed. */
  text: string
  /** The card's progress recorded with this entry, or null when none was given. */
  progress: number | null
  at: number
}

/**
 * An SAP Cloud Integration (CPI) adapter: how a message enters CPI on the
 * sender side, or leaves it on the receiver side.
 */
export type AdapterType =
  | 'idoc'
  | 'rfc'
  | 'soap'
  | 'xi'
  | 'http'
  | 'odata'
  | 'sftp'
  | 'ftp'
  | 'mail'
  | 'as2'
  | 'as4'
  | 'jdbc'
  | 'jms'
  | 'amqp'
  | 'kafka'
  | 'processdirect'
  | 'successfactors'
  | 'ariba'
  | 'ldap'
  | 'openconnectors'
  | 'aws'
  | 'azure'
  | 'other'

/** Asynchronous (fire and forget) or synchronous (request and reply). */
export type MessageMode = 'async' | 'sync'

/** Where a spec stands: being written, out for review, or agreed by both sides. */
export type SpecStatus = 'draft' | 'review' | 'agreed'

/** The technical spec of an integration (CPI iFlow) someone has to build. */
export interface InterfaceSpec {
  /** System that sends the message, e.g. "S/4HANA PRD". */
  senderSystem: string
  senderAdapter: AdapterType
  /** System that receives it, e.g. "Salesforce". */
  receiverSystem: string
  receiverAdapter: AdapterType
  mode: MessageMode
  /** The iFlow name or address, e.g. "/orders/create" or an IDoc type. */
  endpoint: string
  /** Anything else: auth, error handling, retries, volume, schedule. */
  notes: string
  status: SpecStatus
}

export interface Card {
  id: string
  title: string
  description: string
  labelIds: string[]
  /** Team members (ids from the board's team) working on this card. */
  assigneeIds: string[]
  priority: Priority
  /** When work starts, as a local calendar date YYYY-MM-DD, or null when unset. */
  startDate: string | null
  /** Due date (the end date), as a local calendar date YYYY-MM-DD, or null when unset. */
  dueDate: string | null
  /** Estimated effort in man-days (MD), or null when not estimated. */
  estimateDays: number | null
  checklist: ChecklistItem[]
  /** How far along the task is, 0-100, or null when not tracked. */
  progress: number | null
  /** Progress updates, oldest first. */
  progressLog: ProgressEntry[]
  /** Set when the card is an interface to implement; holds its technical spec. */
  spec: InterfaceSpec | null
  createdAt: number
  updatedAt: number
}

export interface Column {
  id: string
  title: string
  cardIds: string[]
  /** Soft limit on cards in progress; 0 means no limit. */
  wipLimit: number
}

export type Role = 'owner' | 'editor' | 'viewer'

export interface Board {
  id: string
  title: string
  columnIds: string[]
  labels: Label[]
  /** People cards on this board can be assigned to. */
  team: TeamMember[]
  createdAt: number
  /** Set when the board lives in an account (and may be shared); absent for boards kept on this device only. */
  cloud?: { role: Role }
}

export interface AppState {
  version: 7
  boardOrder: string[]
  activeBoardId: string | null
  boards: Record<string, Board>
  columns: Record<string, Column>
  cards: Record<string, Card>
}

export type DueFilter = 'any' | 'overdue' | 'today' | 'week' | 'none'

export interface CardFilter {
  query: string
  labelIds: string[]
  priorities: Priority[]
  /** Team member ids; `UNASSIGNED` matches cards nobody is assigned to. */
  assigneeIds: string[]
  due: DueFilter
}
