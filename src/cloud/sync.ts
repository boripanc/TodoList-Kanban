import type { AppState, Role } from '../types'
import type { Action } from '../state/reducer'
import type { CloudApi } from './api'
import { diffBoardDoc, extractBoardDoc, isEmptyOps, type BoardDoc } from './doc'

/**
 * Keeps cloud boards in step with the server.
 *
 * Local edits go through the reducer as usual; `push` diffs each cloud board
 * against the last version the server has and sends only the changed rows,
 * one write at a time. Remote changes are fetched whole and replace the local
 * copy, but only once this device has no writes in flight, so they never
 * clobber a local edit that hasn't been saved yet.
 *
 * Boards are only deleted on the server by an explicit `deleteBoard`; a board
 * that disappears locally for any other reason (sign-out, a backup import) is
 * simply no longer synced.
 */
export class CloudSync {
  /** What the server has, per board, as far as this device knows. */
  private synced = new Map<string, BoardDoc>()
  private updatedAt = new Map<string, string>()
  private queue: Promise<void> = Promise.resolve()
  private pending = 0
  private waitingRefresh = new Set<string>()
  private waitingRefreshAll = false
  private stopped = false
  private api: CloudApi
  private getState: () => AppState
  private dispatch: (action: Action) => void
  private onError: (message: string) => void

  constructor(
    api: CloudApi,
    getState: () => AppState,
    dispatch: (action: Action) => void,
    onError: (message: string) => void,
  ) {
    this.api = api
    this.getState = getState
    this.dispatch = dispatch
    this.onError = onError
  }

  stop() {
    this.stopped = true
    this.synced.clear()
    this.updatedAt.clear()
  }

  /** Writes still on their way to the server. */
  get busy(): boolean {
    return this.pending > 0
  }

  /** Resolves once every queued write has finished. */
  idle(): Promise<void> {
    return this.queue
  }

  /** Send local changes on cloud boards to the server. */
  push(state: AppState = this.getState()) {
    for (const [boardId, prev] of this.synced) {
      const board = state.boards[boardId]
      if (!board?.cloud || board.cloud.role === 'viewer') continue
      const next = extractBoardDoc(state, boardId)
      if (!next) continue
      const ops = diffBoardDoc(prev, next)
      if (isEmptyOps(ops)) continue
      this.synced.set(boardId, next)
      this.enqueue(
        () => this.api.applyOps(boardId, ops),
        () => {
          this.onError('A change could not be saved. Reloading the board from the server.')
          this.updatedAt.delete(boardId)
          this.waitingRefresh.add(boardId)
        },
      )
    }
  }

  /** Upload a board this user just created, or moved from this device to the account. */
  publish(boardId: string) {
    const doc = extractBoardDoc(this.getState(), boardId)
    if (!doc) return
    this.synced.set(boardId, doc)
    this.enqueue(
      () => this.api.createBoard(doc),
      () => {
        this.synced.delete(boardId)
        this.dispatch({ type: 'board/setCloud', boardId, role: null })
        this.onError(`"${doc.board.title}" could not be saved to your account. It is still on this device.`)
      },
    )
  }

  /** Delete a board for everyone. The caller removes it locally. */
  deleteBoard(boardId: string) {
    this.synced.delete(boardId)
    this.enqueue(
      () => this.api.deleteBoard(boardId),
      () => this.onError('The board could not be deleted on the server.'),
    )
  }

  /** Stop syncing a board and drop it from this device. */
  forget(boardId: string) {
    this.synced.delete(boardId)
    this.updatedAt.delete(boardId)
    this.dispatch({ type: 'board/unload', boardId })
  }

  /** Re-fetch one board after it changed elsewhere. */
  async refresh(boardId: string): Promise<void> {
    this.push()
    if (this.pending > 0) {
      this.waitingRefresh.add(boardId)
      return
    }
    const known = this.getState().boards[boardId]?.cloud?.role
    // A board this device doesn't have yet: find out the role with the full list.
    if (!known) return this.refreshAll()
    const doc = await this.api.fetchBoard(boardId)
    if (this.stopped) return
    if (!doc) return this.forget(boardId)
    this.apply(doc, known)
  }

  /**
   * Load the user's boards: fetch new or changed ones, drop ones they lost
   * access to. Unchanged boards are not fetched again.
   */
  async refreshAll(): Promise<void> {
    this.push()
    if (this.pending > 0) {
      this.waitingRefreshAll = true
      return
    }
    const summaries = await this.api.listBoards()
    if (this.stopped) return
    const listed = new Set(summaries.map((s) => s.id))
    const state = this.getState()
    for (const id of state.boardOrder) {
      if (state.boards[id]?.cloud && !listed.has(id)) this.forget(id)
    }
    await Promise.all(
      summaries.map(async (summary) => {
        const current = this.getState().boards[summary.id]
        const unchanged =
          this.synced.has(summary.id) &&
          this.updatedAt.get(summary.id) === summary.updatedAt &&
          current?.cloud?.role === summary.role
        if (unchanged) return
        const doc = await this.api.fetchBoard(summary.id)
        if (this.stopped || !doc) return
        if (this.pending > 0) {
          this.waitingRefresh.add(summary.id)
          return
        }
        this.updatedAt.set(summary.id, summary.updatedAt)
        this.apply(doc, summary.role)
      }),
    )
  }

  private apply(doc: BoardDoc, role: Role) {
    // A local edit made while the fetch was in flight wins; fetch again once it is saved.
    this.push()
    if (this.pending > 0) {
      this.waitingRefresh.add(doc.board.id)
      return
    }
    this.synced.set(doc.board.id, doc)
    this.dispatch({ type: 'board/load', doc, role })
  }

  private enqueue(write: () => Promise<void>, onFail: () => void) {
    this.pending++
    this.queue = this.queue
      .then(write)
      .catch((error: unknown) => {
        console.error(error)
        if (!this.stopped) onFail()
      })
      .finally(() => {
        this.pending--
        if (this.pending === 0 && !this.stopped) this.drain()
      })
  }

  private drain() {
    const boards = [...this.waitingRefresh]
    this.waitingRefresh.clear()
    if (this.waitingRefreshAll) {
      this.waitingRefreshAll = false
      for (const id of boards) this.updatedAt.delete(id)
      void this.refreshAll().catch(() => {})
      return
    }
    for (const id of boards) void this.refresh(id).catch(() => {})
  }
}
