import type { Db } from './db.ts'

export type ServerEvent =
  | { type: 'board'; boardId: string }
  | { type: 'member'; boardId: string; userId: string }
  /** A team changed; when it was deleted, the people who could see it come along. */
  | { type: 'team'; teamId: string; userIds?: string[]; ownerId?: string }

interface Listener {
  userId: string
  send: (event: ServerEvent) => void
}

/**
 * Fans database change notifications out to connected browsers. A board event
 * goes to that board's members; a membership event goes to the person whose
 * access changed; a team event to the team's owner and the members of its
 * boards.
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
    } else if (event.type === 'team') {
      if (event.userIds) {
        recipients = new Set([...event.userIds, ...(event.ownerId ? [event.ownerId] : [])])
      } else {
        const { rows } = await this.db.query<{ user_id: string }>(
          `select owner_id as user_id from kanban.teams where id = $1
           union select m.user_id from kanban.board_members m join kanban.boards b on b.id = m.board_id where b.team_id = $1`,
          [event.teamId],
        )
        recipients = new Set(rows.map((r) => r.user_id))
      }
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
