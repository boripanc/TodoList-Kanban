import type { Db } from './db.ts'

export type ServerEvent = { type: 'board'; boardId: string } | { type: 'member'; boardId: string; userId: string }

interface Listener {
  userId: string
  send: (event: ServerEvent) => void
}

/**
 * Fans database change notifications out to connected browsers. A board event
 * goes to that board's members; a membership event goes to the person whose
 * access changed.
 */
export class EventHub {
  private listeners = new Set<Listener>()
  private db: Db

  constructor(db: Db) {
    this.db = db
  }

  /** Start listening to the database. Returns a function that stops it. */
  start(): Promise<() => Promise<void>> {
    return this.db.listen('kanban_events', (payload) => {
      try {
        void this.dispatch(JSON.parse(payload) as ServerEvent)
      } catch (error) {
        console.error('Live updates: bad notification', error)
      }
    })
  }

  add(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  async dispatch(event: ServerEvent) {
    if (this.listeners.size === 0) return
    let recipients: Set<string>
    if (event.type === 'member') {
      recipients = new Set([event.userId])
    } else {
      const { rows } = await this.db.query<{ user_id: string }>(
        'select user_id from kanban.board_members where board_id = $1',
        [event.boardId],
      )
      recipients = new Set(rows.map((r) => r.user_id))
    }
    for (const listener of this.listeners) {
      if (recipients.has(listener.userId)) listener.send(event)
    }
  }
}
