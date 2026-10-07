export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent'

export interface Label {
  id: string
  name: string
  color: string
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

export interface Card {
  id: string
  title: string
  description: string
  labelIds: string[]
  priority: Priority
  /** Local calendar date as YYYY-MM-DD, or null when unset. */
  dueDate: string | null
  checklist: ChecklistItem[]
  /** How far along the task is, 0-100, or null when not tracked. */
  progress: number | null
  /** Progress updates, oldest first. */
  progressLog: ProgressEntry[]
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
  createdAt: number
  /** Set when the board lives in an account (and may be shared); absent for boards kept on this device only. */
  cloud?: { role: Role }
}

export interface AppState {
  version: 2
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
  due: DueFilter
}
