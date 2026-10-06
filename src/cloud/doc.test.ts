import { describe, expect, it } from 'vitest'
import { initialState, reducer, type Action } from '../state/reducer'
import { addBoardAction } from '../state/storage'
import type { AppState } from '../types'
import { boardRow, cardRows, columnRows, diffBoardDoc, docFromRows, extractBoardDoc, isEmptyOps } from './doc'

const now = 1_700_000_000_000

function setup() {
  let state: AppState = reducer(initialState, addBoardAction('Work', 'work', now))
  const board = state.boards[state.activeBoardId!]
  const [a, b] = board.columnIds
  const actions: Action[] = ['1', '2', '3'].map((id) => ({
    type: 'card/add',
    columnId: a,
    id,
    title: `Card ${id}`,
    now,
  }))
  state = actions.reduce(reducer, state)
  state = reducer(state, { type: 'card/add', columnId: b, id: '4', title: 'Card 4', now })
  return { state, board, a, b }
}

describe('board documents', () => {
  it('round-trips through database rows', () => {
    const { state, board } = setup()
    const doc = extractBoardDoc(state, board.id)!
    const back = docFromRows(boardRow(doc), columnRows(doc).reverse(), cardRows(doc).reverse())
    expect(back).toEqual(doc)
  })

  it('finds nothing to write when nothing changed', () => {
    const { state, board } = setup()
    const doc = extractBoardDoc(state, board.id)!
    expect(isEmptyOps(diffBoardDoc(doc, extractBoardDoc(state, board.id)!))).toBe(true)
  })

  it('writes only the cards whose place or content changed', () => {
    const { state, board, a, b } = setup()
    const before = extractBoardDoc(state, board.id)!
    let next = reducer(state, { type: 'card/move', cardId: '3', toColumnId: b, toIndex: 0 })
    next = reducer(next, { type: 'card/update', cardId: '1', patch: { priority: 'high' }, now })
    const ops = diffBoardDoc(before, extractBoardDoc(next, board.id)!)
    expect(ops.upsertCards.map((c) => [c.id, c.column_id, c.position])).toEqual([
      ['1', a, 0],
      ['3', b, 0],
      ['4', b, 1],
    ])
    expect(ops.board).toBeUndefined()
    expect(ops.upsertColumns).toEqual([])
  })

  it('lists deleted columns and cards and board changes', () => {
    const { state, board, a } = setup()
    const before = extractBoardDoc(state, board.id)!
    let next = reducer(state, { type: 'column/delete', boardId: board.id, columnId: a })
    next = reducer(next, { type: 'board/rename', boardId: board.id, title: 'Office' })
    const ops = diffBoardDoc(before, extractBoardDoc(next, board.id)!)
    expect(ops.deleteColumnIds).toEqual([a])
    expect(ops.deleteCardIds.sort()).toEqual(['1', '2', '3'])
    expect(ops.board?.title).toBe('Office')
    // The remaining columns shift left.
    expect(ops.upsertColumns.map((c) => c.position)).toEqual([0, 1, 2, 3])
  })
})
