import { describe, expect, it } from 'vitest'
import { initialState, reducer, type Action } from '../state/reducer'
import { addBoardAction } from '../state/storage'
import type { AppState } from '../types'
import { MemoryServer } from './memoryApi'
import { CloudSync } from './sync'
import type { CloudUser } from './api'

const now = 1_700_000_000_000

/** One person's browser: local state, an API client and a sync engine. */
function device(server: MemoryServer, user: CloudUser) {
  let state: AppState = initialState
  const api = server.client(user)
  const errors: string[] = []
  const dispatch = (action: Action) => {
    state = reducer(state, action)
  }
  const sync = new CloudSync(
    api,
    () => state,
    dispatch,
    (m) => errors.push(m),
  )
  return {
    api,
    sync,
    errors,
    dispatch,
    get state() {
      return state
    },
    /** Make a local edit and send it, the way the app does after each change. */
    async edit(...actions: Action[]) {
      actions.forEach(dispatch)
      sync.push()
      await sync.idle()
    },
  }
}

async function sharedSetup(role: 'editor' | 'viewer' = 'editor') {
  const server = new MemoryServer()
  const ana = device(server, server.addUser('ana@example.com'))
  const ben = device(server, server.addUser('ben@example.com'))
  const add = addBoardAction('Trip', 'personal', now)
  ana.dispatch(add)
  ana.dispatch({ type: 'board/setCloud', boardId: add.id, role: 'owner' })
  ana.sync.publish(add.id)
  await ana.sync.idle()
  await ana.api.inviteByEmail(add.id, 'Ben@Example.com', role)
  const [invite] = await ben.api.listReceivedInvites()
  await ben.api.acceptInvite(invite.id)
  await ben.sync.refreshAll()
  const board = ana.state.boards[add.id]
  return { server, ana, ben, board, firstColumn: board.columnIds[0] }
}

describe('cloud sync', () => {
  it('shares a board: the invitee loads it and both see each other’s edits', async () => {
    const { ana, ben, board, firstColumn } = await sharedSetup()
    expect(ben.state.boards[board.id]).toMatchObject({ title: 'Trip', cloud: { role: 'editor' } })

    await ben.edit({ type: 'card/add', columnId: firstColumn, id: 'c1', title: 'Book flights', now })
    await ana.sync.refresh(board.id)
    expect(ana.state.columns[firstColumn].cardIds).toEqual(['c1'])

    await ana.edit({ type: 'card/move', cardId: 'c1', toColumnId: board.columnIds[2], toIndex: 0 })
    await ben.sync.refresh(board.id)
    expect(ben.state.columns[board.columnIds[2]].cardIds).toEqual(['c1'])
    expect(ben.state.columns[firstColumn].cardIds).toEqual([])
  })

  it('merges edits to different cards made at the same time', async () => {
    const { ana, ben, board, firstColumn } = await sharedSetup()
    await ana.edit(
      { type: 'card/add', columnId: firstColumn, id: 'c1', title: 'One', now },
      { type: 'card/add', columnId: firstColumn, id: 'c2', title: 'Two', now },
    )
    await ben.sync.refresh(board.id)
    // Both edit before either has seen the other's change.
    await ana.edit({ type: 'card/update', cardId: 'c1', patch: { title: 'One (Ana)' }, now })
    await ben.edit({ type: 'card/update', cardId: 'c2', patch: { title: 'Two (Ben)' }, now })
    await ana.sync.refresh(board.id)
    await ben.sync.refresh(board.id)
    for (const person of [ana, ben]) {
      expect(person.state.cards.c1.title).toBe('One (Ana)')
      expect(person.state.cards.c2.title).toBe('Two (Ben)')
    }
  })

  it('does not overwrite a local edit that is still being saved', async () => {
    const { ana, ben, board, firstColumn } = await sharedSetup()
    await ben.edit({ type: 'card/add', columnId: firstColumn, id: 'remote', title: 'From Ben', now })
    ana.dispatch({ type: 'card/add', columnId: firstColumn, id: 'local', title: 'From Ana', now })
    // A remote change arrives before Ana's edit was sent.
    await ana.sync.refresh(board.id)
    await ana.sync.idle()
    await new Promise((r) => setTimeout(r, 0))
    await ana.sync.idle()
    expect(ana.state.columns[firstColumn].cardIds.sort()).toEqual(['local', 'remote'])
  })

  it('never sends a viewer’s changes', async () => {
    const { ana, ben, board, firstColumn, server } = await sharedSetup('viewer')
    expect(ben.state.boards[board.id].cloud?.role).toBe('viewer')
    await ben.edit({ type: 'card/add', columnId: firstColumn, id: 'x', title: 'Sneaky', now })
    expect(ben.state.cards.x).toBeUndefined()
    expect(server.cards.size).toBe(0)
    expect(ben.errors).toEqual([])
    expect(ana.state.boards[board.id].cloud?.role).toBe('owner')
  })

  it('drops the board for someone who is removed, and for everyone when it is deleted', async () => {
    const { ana, ben, board, server } = await sharedSetup()
    const cat = device(server, server.addUser('cat@example.com'))
    const token = await ana.api.createInviteLink(board.id, 'viewer')
    await cat.api.joinWithLink(token)
    await cat.sync.refreshAll()
    expect(cat.state.boards[board.id].cloud?.role).toBe('viewer')

    await ana.api.removeMember(board.id, server.members.find((m) => m.role === 'editor')!.userId)
    await ben.sync.refreshAll()
    expect(ben.state.boards[board.id]).toBeUndefined()

    ana.sync.deleteBoard(board.id)
    ana.dispatch({ type: 'board/delete', boardId: board.id })
    await ana.sync.idle()
    await cat.sync.refreshAll()
    expect(cat.state.boards[board.id]).toBeUndefined()
    expect(server.boards.size).toBe(0)
  })

  it('reloads the board from the server when a write is rejected', async () => {
    const { ana, ben, board, firstColumn } = await sharedSetup()
    const benId = (await ana.api.listMembers(board.id)).find((m) => m.role === 'editor')!.userId
    await ana.api.setMemberRole(board.id, benId, 'viewer')
    // Ben hasn't noticed the role change yet and keeps editing.
    await ben.edit({ type: 'card/add', columnId: firstColumn, id: 'late', title: 'Too late', now })
    await new Promise((r) => setTimeout(r, 0))
    await ben.sync.idle()
    expect(ben.errors[0]).toMatch(/could not be saved/)
    await ben.sync.refreshAll()
    expect(ben.state.cards.late).toBeUndefined()
    expect(ben.state.boards[board.id].cloud?.role).toBe('viewer')
  })

  it('puts a board back on the device if uploading it fails', async () => {
    const server = new MemoryServer()
    const ana = device(server, server.addUser('ana@example.com'))
    const add = addBoardAction('Trip', 'personal', now)
    ana.dispatch(add)
    ana.api.createBoard = async () => {
      throw new Error('offline')
    }
    ana.dispatch({ type: 'board/setCloud', boardId: add.id, role: 'owner' })
    ana.sync.publish(add.id)
    await ana.sync.idle()
    expect(ana.state.boards[add.id].cloud).toBeUndefined()
    expect(ana.errors[0]).toMatch(/still on this device/)
  })
})
