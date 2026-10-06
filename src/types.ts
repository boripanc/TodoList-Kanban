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

export interface Card {
  id: string
  title: string
  description: string
  labelIds: string[]
  priority: Priority
  /** Local calendar date as YYYY-MM-DD, or null when unset. */
  dueDate: string | null
  checklist: ChecklistItem[]
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

export interface Board {
  id: string
  title: string
  columnIds: string[]
  labels: Label[]
  createdAt: number
}

export interface AppState {
  version: 1
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
