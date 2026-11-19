import type { AppState, Role } from '../types'
import type { Action } from '../state/reducer'
import type { CloudApi } from './api'
import { diffBoardDoc, extractBoardDoc, isEmptyOps, teamFromRow, teamRow, type BoardDoc, type TeamRow } from './doc'

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
 *
 * Teams sync the same way, as whole rows: `publishTeam` and `deleteTeam` are
 * explicit, `push` saves changed teams (before boards, so a board never
 * points at a team the server doesn't have yet), and `refreshTeams` replaces
 * the local copies.
 */
export class CloudSync {
  /** What the server has, per board, as far as this device knows. */
  private synced = new Map<string, BoardDoc>()
  private updatedAt = new Map<string, string>()
  /** What the server has, per team. */
  private syncedTeams = new Map<string, TeamRow>()
  private waitingTeams = false
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
    this.syncedTeams.clear()
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
    for (const [teamId, prev] of this.syncedTeams) {
      const team = state.teams[teamId]
      if (!team?.cloud || team.cloud.role === 'viewer') continue
      const next = teamRow(team)
      if (JSON.stringify(prev) === JSON.stringify(next)) continue
      this.syncedTeams.set(teamId, next)
      this.enqueue(
        () => this.api.saveTeam(next),
        () => {
          this.onError('A change to the team could not be saved. Reloading teams from the server.')
          this.waitingTeams = true
        },
      )
    }
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

  /** Save a team this user just created in the account. */
  publishTeam(teamId: string) {
    const team = this.getState().teams[teamId]
    if (!team) return
    const row = teamRow(team)
    this.syncedTeams.set(teamId, row)
    this.enqueue(
      () => this.api.saveTeam(row),
      () => {
        this.onError(`The team "${row.name}" could not be saved to your account.`)
        this.syncedTeams.delete(teamId)
        this.waitingTeams = true
      },
    )
  }

  /** Delete a team for everyone. The caller removes it locally. */
  deleteTeam(teamId: string) {
    this.syncedTeams.delete(teamId)
    this.enqueue(
      () => this.api.deleteTeam(teamId),
      () => {
        this.onError('The team could not be deleted on the server.')
        this.waitingTeams = true
      },
    )
  }

  /** Load the user's teams from the server in place of the local copies. */
  async refreshTeams(): Promise<void> {
    this.push()
    if (this.pending > 0) {
      this.waitingTeams = true
      return
    }
    const list = await this.api.listTeams()
    if (this.stopped) return
    if (this.pending > 0) {
      this.waitingTeams = true
      return
    }
    this.syncedTeams = new Map(list.map(({ role: _role, ...row }) => [row.id, row]))
    this.dispatch({ type: 'teams/load', teams: list.map(teamFromRow) })
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
    const [summaries] = await Promise.all([this.api.listBoards(), this.refreshTeams()])
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
    // The board joined a team this device doesn't have yet.
    const teamId = doc.board.teamId
    if (teamId && !this.getState().teams[teamId]) void this.refreshTeams().catch(() => {})
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
    if (this.waitingTeams && !this.waitingRefreshAll) {
      this.waitingTeams = false
      void this.refreshTeams().catch(() => {})
    }
    if (this.waitingRefreshAll) {
      this.waitingRefreshAll = false
      this.waitingTeams = false
      for (const id of boards) this.updatedAt.delete(id)
      void this.refreshAll().catch(() => {})
      return
    }
    for (const id of boards) void this.refresh(id).catch(() => {})
  }
}
