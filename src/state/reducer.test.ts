import { describe, expect, it } from 'vitest'
import { initialState, reducer, type Action } from './reducer'
import { addBoardAction } from './storage'
import type { AppState } from '../types'

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
  it('adds, updates and deletes a card', () => {
    let { state, board } = workBoard()
    const col = board.columnIds[0]
    state = run(
      state,
      { type: 'card/add', columnId: col, id: 'c1', title: '  Write report  ', now },
      { type: 'card/update', cardId: 'c1', patch: { priority: 'high', dueDate: '2030-01-01' }, now: now + 1 },
    )
    expect(state.cards.c1).toMatchObject({ title: 'Write report', priority: 'high', dueDate: '2030-01-01' })
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
