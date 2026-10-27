import { describe, expect, it } from 'vitest'
import { initialState, reducer, type Action } from './reducer'
import { addBoardAction } from './storage'
import type { AppState } from '../types'
import { extractBoardDoc } from '../cloud/doc'

const now = 1_700_000_000_000

function run(state: AppState, ...actions: Action[]): AppState {
  return actions.reduce(reducer, state)
}

function workBoard() {
  const state = reducer(initialState, addBoardAction('Work', 'work', now))
  const board = state.boards[state.activeBoardId!]
  return { state, board }
}

describe('boards', () => {
  it('creates a board from a template and selects it', () => {
    const { state, board } = workBoard()
    expect(board.title).toBe('Work')
    expect(board.columnIds.map((id) => state.columns[id].title)).toEqual([
      'Backlog',
      'To do',
      'In progress',
      'Review',
      'Done',
    ])
    expect(board.labels.map((l) => l.name)).toContain('Bug')
    expect(state.boardOrder).toEqual([board.id])
  })

  it('deletes a board with its columns and cards and selects the next one', () => {
    let { state, board } = workBoard()
    state = run(state, { type: 'card/add', columnId: board.columnIds[0], id: 'c1', title: 'Task', now })
    state = reducer(state, addBoardAction('Home', 'personal', now))
    const home = state.activeBoardId!
    state = run(state, { type: 'board/select', boardId: board.id }, { type: 'board/delete', boardId: board.id })
    expect(state.boards[board.id]).toBeUndefined()
    expect(state.cards.c1).toBeUndefined()
    expect(board.columnIds.some((id) => state.columns[id])).toBe(false)
    expect(state.activeBoardId).toBe(home)
  })

  it('ignores blank renames', () => {
    const { state, board } = workBoard()
    expect(reducer(state, { type: 'board/rename', boardId: board.id, title: '   ' })).toBe(state)
  })
})

describe('cards', () => {
  it('starts a card when it lands in progress, with a due date from its estimate', () => {
    let { state, board } = workBoard()
    const [, todo, doing] = board.columnIds
    const projectLabel = { id: 'lp', name: 'Project', color: '#f76b15' }
    state = run(
      state,
      { type: 'label/add', boardId: board.id, label: projectLabel },
      { type: 'card/add', columnId: todo, id: 'c1', title: 'Fix import', now },
      { type: 'card/add', columnId: todo, id: 'c2', title: 'Rollout', now },
      { type: 'card/update', cardId: 'c1', patch: { estimateDays: 3 }, now },
      { type: 'card/update', cardId: 'c2', patch: { estimateDays: 3, labelIds: ['lp'] }, now },
      // Not in progress yet: nothing changes.
      { type: 'card/startWork', cardId: 'c1', today: '2026-10-21', now: now + 1 },
    )
    expect(state.cards.c1).toMatchObject({ startDate: null, dueDate: null, updatedAt: now })

    state = run(
      state,
      { type: 'card/move', cardId: 'c1', toColumnId: doing, toIndex: 0 },
      { type: 'card/move', cardId: 'c2', toColumnId: doing, toIndex: 0 },
      { type: 'card/startWork', cardId: 'c1', today: '2026-10-22', now: now + 2 },
      { type: 'card/startWork', cardId: 'c2', today: '2026-10-22', now: now + 2 },
    )
    expect(state.cards.c1).toMatchObject({ startDate: '2026-10-22', dueDate: '2026-10-26', updatedAt: now + 2 })
    // Project cards keep the dates set by hand.
    expect(state.cards.c2).toMatchObject({ startDate: null, dueDate: null })

    // Moving back and in again keeps the first start date.
    state = run(
      state,
      { type: 'card/move', cardId: 'c1', toColumnId: todo, toIndex: 0 },
      { type: 'card/move', cardId: 'c1', toColumnId: doing, toIndex: 0 },
      { type: 'card/startWork', cardId: 'c1', today: '2026-11-02', now: now + 3 },
    )
    expect(state.cards.c1.startDate).toBe('2026-10-22')
  })

  it('adds, updates and deletes a card', () => {
    let { state, board } = workBoard()
    const col = board.columnIds[0]
    state = run(
      state,
      { type: 'card/add', columnId: col, id: 'c1', title: '  Write report  ', now },
      {
        type: 'card/update',
        cardId: 'c1',
        patch: { priority: 'high', startDate: '2029-12-01', dueDate: '2030-01-01' },
        now: now + 1,
      },
    )
    expect(state.cards.c1).toMatchObject({
      title: 'Write report',
      priority: 'high',
      startDate: '2029-12-01',
      dueDate: '2030-01-01',
    })
    expect(state.cards.c1.updatedAt).toBe(now + 1)
    expect(state.columns[col].cardIds).toEqual(['c1'])

    state = reducer(state, { type: 'card/delete', cardId: 'c1' })
    expect(state.cards.c1).toBeUndefined()
    expect(state.columns[col].cardIds).toEqual([])
  })

  it('does not add a card with an empty title', () => {
    const { state, board } = workBoard()
    expect(reducer(state, { type: 'card/add', columnId: board.columnIds[0], id: 'x', title: ' ', now })).toBe(state)
  })

  it('moves cards within and across columns', () => {
    let { state, board } = workBoard()
    const [a, b] = board.columnIds
    state = run(
      state,
      { type: 'card/add', columnId: a, id: '1', title: 'One', now },
      { type: 'card/add', columnId: a, id: '2', title: 'Two', now },
      { type: 'card/add', columnId: a, id: '3', title: 'Three', now },
      { type: 'card/move', cardId: '3', toColumnId: a, toIndex: 0 },
    )
    expect(state.columns[a].cardIds).toEqual(['3', '1', '2'])

    state = reducer(state, { type: 'card/move', cardId: '1', toColumnId: b, toIndex: 99 })
    expect(state.columns[a].cardIds).toEqual(['3', '2'])
    expect(state.columns[b].cardIds).toEqual(['1'])
  })

  it('duplicates a card right after the original', () => {
    let { state, board } = workBoard()
    const col = board.columnIds[0]
    state = run(
      state,
      { type: 'card/add', columnId: col, id: '1', title: 'One', now },
      { type: 'card/add', columnId: col, id: '2', title: 'Two', now },
      { type: 'card/update', cardId: '1', patch: { checklist: [{ id: 'i', text: 'step', done: true }] }, now },
      { type: 'card/duplicate', cardId: '1', newId: 'copy', now },
    )
    expect(state.columns[col].cardIds).toEqual(['1', 'copy', '2'])
    expect(state.cards.copy.title).toBe('One (copy)')
    expect(state.cards.copy.checklist[0]).toMatchObject({ text: 'step', done: true })
    expect(state.cards.copy.checklist[0].id).not.toBe('i')
  })
})

describe('progress', () => {
  function withCard() {
    const { state, board } = workBoard()
    return run(state, { type: 'card/add', columnId: board.columnIds[0], id: 'c1', title: 'Task', now })
  }

  it('starts untracked and keeps progress between 0 and 100', () => {
    let state = withCard()
    expect(state.cards.c1).toMatchObject({ progress: null, progressLog: [] })
    state = run(state, { type: 'card/update', cardId: 'c1', patch: { progress: 42.6 }, now })
    expect(state.cards.c1.progress).toBe(43)
    state = run(state, { type: 'card/update', cardId: 'c1', patch: { progress: 150 }, now })
    expect(state.cards.c1.progress).toBe(100)
    state = run(state, { type: 'card/update', cardId: 'c1', patch: { progress: -5 }, now })
    expect(state.cards.c1.progress).toBe(0)
    state = run(state, { type: 'card/update', cardId: 'c1', patch: { progress: null }, now })
    expect(state.cards.c1.progress).toBeNull()
  })

  it('logs progress updates, setting the progress when one is given', () => {
    let state = withCard()
    state = run(
      state,
      { type: 'card/logProgress', cardId: 'c1', id: 'p1', text: '  Drafted outline ', progress: 30, now: now + 1 },
      { type: 'card/logProgress', cardId: 'c1', id: 'p2', text: 'Waiting on review', progress: null, now: now + 2 },
    )
    expect(state.cards.c1.progress).toBe(30)
    expect(state.cards.c1.progressLog).toEqual([
      { id: 'p1', text: 'Drafted outline', progress: 30, at: now + 1 },
      { id: 'p2', text: 'Waiting on review', progress: null, at: now + 2 },
    ])
    expect(state.cards.c1.updatedAt).toBe(now + 2)

    // Nothing to log: no text and no progress.
    expect(reducer(state, { type: 'card/logProgress', cardId: 'c1', id: 'p3', text: ' ', progress: null, now })).toBe(
      state,
    )

    state = run(state, { type: 'card/deleteProgress', cardId: 'c1', entryId: 'p1', now })
    expect(state.cards.c1.progressLog.map((e) => e.id)).toEqual(['p2'])
    expect(state.cards.c1.progress).toBe(30)
    expect(reducer(state, { type: 'card/deleteProgress', cardId: 'c1', entryId: 'nope', now })).toBe(state)
  })

  it('starts a duplicate without progress', () => {
    let state = withCard()
    state = run(
      state,
      { type: 'card/logProgress', cardId: 'c1', id: 'p1', text: 'Half way', progress: 50, now },
      { type: 'card/duplicate', cardId: 'c1', newId: 'copy', now },
    )
    expect(state.cards.copy).toMatchObject({ progress: null, progressLog: [] })
    expect(state.cards.c1.progress).toBe(50)
  })
})

describe('columns', () => {
  it('adds, reorders, limits and deletes columns', () => {
    let { state, board } = workBoard()
    state = run(
      state,
      { type: 'column/add', boardId: board.id, id: 'new', title: 'Blocked' },
      { type: 'column/move', boardId: board.id, columnId: 'new', toIndex: 1 },
      { type: 'column/update', columnId: 'new', patch: { wipLimit: -4 } },
    )
    expect(state.boards[board.id].columnIds[1]).toBe('new')
    expect(state.columns.new.wipLimit).toBe(0)

    state = run(
      state,
      { type: 'card/add', columnId: 'new', id: 'c', title: 'Waiting', now },
      { type: 'column/delete', boardId: board.id, columnId: 'new' },
    )
    expect(state.columns.new).toBeUndefined()
    expect(state.cards.c).toBeUndefined()
    expect(state.boards[board.id].columnIds).not.toContain('new')
  })

  it('clears all cards in a column', () => {
    let { state, board } = workBoard()
    const col = board.columnIds[4]
    state = run(
      state,
      { type: 'card/add', columnId: col, id: '1', title: 'Done 1', now },
      { type: 'card/add', columnId: col, id: '2', title: 'Done 2', now },
      { type: 'column/clear', columnId: col },
    )
    expect(state.columns[col].cardIds).toEqual([])
    expect(state.cards['1']).toBeUndefined()
  })
})

describe('interfaces', () => {
  it('adds an interface with an empty spec, assigned to a team member', () => {
    let state = reducer(initialState, addBoardAction('Checkout', 'project', now))
    const board = state.boards[state.activeBoardId!]
    expect(board.columnIds.map((id) => state.columns[id].title)).toEqual([
      'Spec',
      'To implement',
      'In progress',
      'Review',
      'Done',
    ])
    state = run(
      state,
      { type: 'team/add', boardId: board.id, member: { id: 'm1', name: 'Kim', color: '#0090ff', capacity: 0 } },
      { type: 'card/addInterface', columnId: board.columnIds[0], id: 'i1', title: ' Create order ', senderAdapter: 'idoc', receiverAdapter: 'http', memberId: 'm1', now },
      { type: 'card/addInterface', columnId: board.columnIds[0], id: 'i2', title: 'Ghost', senderAdapter: 'rfc', receiverAdapter: 'soap', memberId: 'nobody', now },
    )
    expect(state.cards.i1).toMatchObject({
      title: 'Create order',
      assigneeIds: ['m1'],
      spec: {
        senderSystem: '',
        senderAdapter: 'idoc',
        receiverSystem: '',
        receiverAdapter: 'http',
        mode: 'async',
        endpoint: '',
        input: '',
        output: '',
        notes: '',
        status: 'draft',
      },
    })
    // Someone not on the team is left off.
    expect(state.cards.i2).toMatchObject({ assigneeIds: [], spec: { senderAdapter: 'rfc', receiverAdapter: 'soap' } })
    expect(state.columns[board.columnIds[0]].cardIds).toEqual(['i1', 'i2'])
    // Blank titles and taken ids add nothing.
    const blank = { type: 'card/addInterface', columnId: board.columnIds[0], id: 'i3', title: ' ', senderAdapter: 'idoc', receiverAdapter: 'http', memberId: null, now } as const
    expect(reducer(state, blank)).toBe(state)
    expect(reducer(state, { ...blank, id: 'i1', title: 'Again' }).cards.i1.title).toBe('Create order')
  })

  it('changes part of a spec, gives plain cards one, and removes it', () => {
    let { state, board } = workBoard()
    state = run(state, { type: 'card/add', columnId: board.columnIds[0], id: 'c1', title: 'Orders API', now })
    expect(state.cards.c1.spec).toBeNull()
    state = run(state, { type: 'card/updateSpec', cardId: 'c1', patch: { endpoint: 'POST /orders' }, now: now + 1 })
    expect(state.cards.c1).toMatchObject({ spec: { senderAdapter: 'idoc', endpoint: 'POST /orders', status: 'draft' }, updatedAt: now + 1 })
    state = run(state, { type: 'card/updateSpec', cardId: 'c1', patch: { status: 'agreed', output: '201' }, now })
    expect(state.cards.c1.spec).toMatchObject({ endpoint: 'POST /orders', output: '201', status: 'agreed' })

    // A copy gets its own spec.
    state = run(state, { type: 'card/duplicate', cardId: 'c1', newId: 'c2', now })
    expect(state.cards.c2.spec).toEqual(state.cards.c1.spec)
    expect(state.cards.c2.spec).not.toBe(state.cards.c1.spec)

    state = run(state, { type: 'card/updateSpec', cardId: 'c1', patch: null, now })
    expect(state.cards.c1.spec).toBeNull()
    expect(state.cards.c2.spec).not.toBeNull()
    expect(reducer(state, { type: 'card/updateSpec', cardId: 'c1', patch: null, now })).toBe(state)
  })

  it('stops viewers from changing specs', () => {
    let { state, board } = workBoard()
    state = run(
      state,
      { type: 'card/add', columnId: board.columnIds[0], id: 'c1', title: 'Orders API', now },
      { type: 'board/setCloud', boardId: board.id, role: 'viewer' },
    )
    expect(reducer(state, { type: 'card/updateSpec', cardId: 'c1', patch: { endpoint: 'x' }, now })).toBe(state)
    const add = { type: 'card/addInterface', columnId: board.columnIds[0], id: 'i1', title: 'x', senderAdapter: 'idoc', receiverAdapter: 'http', memberId: null, now } as const
    expect(reducer(state, add)).toBe(state)
  })
})

describe('labels', () => {
  it('removes a deleted label from every card', () => {
    let { state, board } = workBoard()
    const bug = board.labels.find((l) => l.name === 'Bug')!.id
    state = run(
      state,
      { type: 'card/add', columnId: board.columnIds[0], id: 'c', title: 'Crash', now },
      { type: 'card/update', cardId: 'c', patch: { labelIds: [bug] }, now },
      { type: 'label/delete', boardId: board.id, labelId: bug },
    )
    expect(state.cards.c.labelIds).toEqual([])
    expect(state.boards[board.id].labels.some((l) => l.id === bug)).toBe(false)
  })
})

describe('team', () => {
  const ana = { id: 'ana', name: 'Ana', color: '#0090ff', capacity: 3 }
  const ben = { id: 'ben', name: 'Ben', color: '#d6409f', capacity: 0 }

  function teamBoard() {
    const { state, board } = workBoard()
    return {
      board,
      state: run(
        state,
        { type: 'team/add', boardId: board.id, member: ana },
        { type: 'team/add', boardId: board.id, member: ben },
        { type: 'card/add', columnId: board.columnIds[0], id: 'c', title: 'Task', now },
      ),
    }
  }

  it('starts a new board and card with nobody on them', () => {
    const { state, board } = workBoard()
    const next = run(state, { type: 'card/add', columnId: board.columnIds[0], id: 'c', title: 'Task', now })
    expect(next.boards[board.id].team).toEqual([])
    expect(next.cards.c.assigneeIds).toEqual([])
  })

  it('adds, renames and limits team members, refusing blank names and duplicate ids', () => {
    let { state, board } = teamBoard()
    expect(state.boards[board.id].team.map((m) => m.name)).toEqual(['Ana', 'Ben'])
    state = run(
      state,
      { type: 'team/add', boardId: board.id, member: { ...ana, name: 'Again' } },
      { type: 'team/add', boardId: board.id, member: { ...ana, id: 'x', name: '   ' } },
      { type: 'team/update', boardId: board.id, memberId: 'ana', patch: { name: '  Ana Lee ', capacity: 4.7 } },
      { type: 'team/update', boardId: board.id, memberId: 'ben', patch: { name: ' ', capacity: -2 } },
    )
    expect(state.boards[board.id].team).toEqual([
      { ...ana, name: 'Ana Lee', capacity: 4 },
      { ...ben, capacity: 0 },
    ])
  })

  it('assigns a card to several people and takes them off again', () => {
    let { state } = teamBoard()
    state = run(
      state,
      { type: 'card/toggleAssignee', cardId: 'c', memberId: 'ana', now: now + 1 },
      { type: 'card/toggleAssignee', cardId: 'c', memberId: 'ben', now: now + 2 },
    )
    expect(state.cards.c.assigneeIds).toEqual(['ana', 'ben'])
    expect(state.cards.c.updatedAt).toBe(now + 2)
    state = reducer(state, { type: 'card/toggleAssignee', cardId: 'c', memberId: 'ana', now })
    expect(state.cards.c.assigneeIds).toEqual(['ben'])
    // Someone who isn't on the board's team can't be assigned.
    expect(reducer(state, { type: 'card/toggleAssignee', cardId: 'c', memberId: 'zoe', now })).toBe(state)
  })

  it('removes a deleted team member from every card', () => {
    let { state, board } = teamBoard()
    state = run(
      state,
      { type: 'card/update', cardId: 'c', patch: { assigneeIds: ['ana', 'ben'] }, now },
      { type: 'card/duplicate', cardId: 'c', newId: 'd', now },
      { type: 'team/delete', boardId: board.id, memberId: 'ana' },
    )
    expect(state.cards.c.assigneeIds).toEqual(['ben'])
    expect(state.cards.d.assigneeIds).toEqual(['ben'])
    expect(state.boards[board.id].team.map((m) => m.id)).toEqual(['ben'])
  })
})

describe('shared boards', () => {
  function sharedBoard(role: 'owner' | 'editor' | 'viewer') {
    const { state, board } = workBoard()
    const withCard = run(state, { type: 'card/add', columnId: board.columnIds[0], id: 'c1', title: 'Task', now })
    const doc = extractBoardDoc(withCard, board.id)!
    return { doc, state: reducer(initialState, { type: 'board/load', doc, role }), board }
  }

  it('loads a board from the cloud and replaces it on reload', () => {
    const { doc, state, board } = sharedBoard('editor')
    expect(state.boards[board.id].cloud).toEqual({ role: 'editor' })
    expect(state.activeBoardId).toBe(board.id)
    expect(state.cards.c1.title).toBe('Task')

    const changed = {
      ...doc,
      columns: doc.columns.map((c, i) => (i === 0 ? { ...c, cardIds: [] } : c)),
      cards: [],
    }
    const next = reducer(state, { type: 'board/load', doc: changed, role: 'viewer' })
    expect(next.cards.c1).toBeUndefined()
    expect(next.boards[board.id].cloud).toEqual({ role: 'viewer' })
    expect(next.boardOrder).toEqual([board.id])
  })

  it('stops viewers from changing anything', () => {
    const { state, board } = sharedBoard('viewer')
    const col = board.columnIds[0]
    const attempts: Action[] = [
      { type: 'board/rename', boardId: board.id, title: 'Mine now' },
      { type: 'column/add', boardId: board.id, id: 'x', title: 'X' },
      { type: 'column/update', columnId: col, patch: { title: 'Renamed' } },
      { type: 'card/add', columnId: col, id: 'c2', title: 'New' },
      { type: 'card/update', cardId: 'c1', patch: { title: 'Edited' }, now },
      { type: 'card/move', cardId: 'c1', toColumnId: board.columnIds[1], toIndex: 0 },
      { type: 'card/delete', cardId: 'c1' },
      { type: 'card/logProgress', cardId: 'c1', id: 'p1', text: 'Done', progress: 100 },
      { type: 'card/deleteProgress', cardId: 'c1', entryId: 'p1' },
      { type: 'label/delete', boardId: board.id, labelId: board.labels[0].id },
      { type: 'team/add', boardId: board.id, member: { id: 'm', name: 'Me', color: '#000000', capacity: 0 } },
      { type: 'card/toggleAssignee', cardId: 'c1', memberId: 'm' },
    ].map((a) => ({ now, ...a }) as Action)
    for (const action of attempts) expect(reducer(state, action)).toBe(state)
    expect(reducer(state, { type: 'board/select', boardId: board.id }).activeBoardId).toBe(board.id)
  })

  it('lets editors change shared boards', () => {
    const { state } = sharedBoard('editor')
    expect(reducer(state, { type: 'card/update', cardId: 'c1', patch: { title: 'Edited' }, now }).cards.c1.title).toBe(
      'Edited',
    )
  })

  it('unloads one cloud board, or all of them on sign-out, keeping device boards', () => {
    const { state: shared, board } = sharedBoard('owner')
    let state = reducer(shared, addBoardAction('Home', 'personal', now))
    const home = state.activeBoardId!
    expect(reducer(state, { type: 'board/unload', boardId: board.id }).boardOrder).toEqual([home])
    state = reducer(state, { type: 'cloud/clear' })
    expect(state.boardOrder).toEqual([home])
    expect(state.cards.c1).toBeUndefined()
  })

  it('marks a device board as an account board and back', () => {
    const { state, board } = workBoard()
    const moved = reducer(state, { type: 'board/setCloud', boardId: board.id, role: 'owner' })
    expect(moved.boards[board.id].cloud).toEqual({ role: 'owner' })
    expect(reducer(moved, { type: 'board/setCloud', boardId: board.id, role: null }).boards[board.id]).not.toHaveProperty(
      'cloud',
    )
  })

  it('keeps account boards when a backup replaces device boards', () => {
    const { state: shared, board } = sharedBoard('editor')
    const backup = reducer(initialState, addBoardAction('From backup', 'blank', now))
    const state = reducer(shared, { type: 'state/replace', state: backup })
    expect(state.boardOrder).toEqual([backup.boardOrder[0], board.id])
    expect(state.boards[board.id].cloud).toEqual({ role: 'editor' })
    expect(state.activeBoardId).toBe(backup.boardOrder[0])

    // A backup that contains the account board itself does not overwrite it.
    const again = reducer(state, { type: 'state/replace', state: { ...shared, activeBoardId: null } })
    expect(again.boardOrder).toEqual([board.id])
    expect(again.boards[board.id].cloud).toEqual({ role: 'editor' })
  })
})
