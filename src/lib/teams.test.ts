import { describe, expect, it } from 'vitest'
import type { TeamMember } from '../types'
import { initialState, reducer, type Action } from '../state/reducer'
import { addBoardAction } from '../state/storage'
import { carryMembers, mergeMembers, remapIds, teamsForBoard } from './teams'
import { teamWorkload } from './workload'

const person = (id: string, name: string, capacity = 0): TeamMember => ({ id, name, color: '#000000', capacity })

describe('teams', () => {
  it('brings people over to another team by id or name, adding the ones it lacks', () => {
    const source = [person('a', 'Ana'), person('b', 'Ben'), person('c', 'Cy')]
    const target = [person('x', 'ana'), person('b', 'Bea')]
    const { members, map } = carryMembers(source, target, ['a', 'b', 'c', 'a', 'gone'])
    expect(members.map((m) => m.id)).toEqual(['x', 'b', 'c'])
    expect([...map]).toEqual([
      ['a', 'x'],
      ['b', 'b'],
      ['c', 'c'],
    ])
    expect(remapIds(['c', 'a', 'x'], map)).toEqual(['c', 'x'])
  })

  it('joins several boards’ teams, matching people by name', () => {
    const { members, maps } = mergeMembers([
      [person('a', 'Ana', 2), person('b', 'Ben')],
      [person('a2', ' ana ', 5), person('a', 'Cy')],
    ])
    expect(members.map((m) => [m.id, m.name, m.capacity])).toEqual([
      ['a', 'Ana', 5],
      ['b', 'Ben', 0],
      ['a-2', 'Cy', 0],
    ])
    expect(maps[1].get('a2')).toBe('a')
    expect(maps[1].get('a')).toBe('a-2')
  })

  it('works out a team’s workload over all its boards', () => {
    const now = 1
    let state = reducer(initialState, addBoardAction('One', 'personal', now))
    const one = state.boards[state.activeBoardId!]
    state = reducer(state, addBoardAction('Two', 'personal', now))
    const two = state.boards[state.activeBoardId!]
    for (const action of [
      { type: 'team/create', id: 't', name: 'T', cloud: false, boardId: one.id, now },
      { type: 'board/setTeam', boardId: two.id, teamId: 't' },
      { type: 'member/add', teamId: 't', member: person('a', 'Ana', 1) },
      { type: 'card/add', columnId: one.columnIds[0], id: 'c1', title: 'One', now, details: { assigneeIds: ['a'] } },
      { type: 'card/add', columnId: two.columnIds[0], id: 'c2', title: 'Two', now, details: { assigneeIds: ['a'] } },
      { type: 'card/add', columnId: two.columnIds[2], id: 'c3', title: 'Done', now, details: { assigneeIds: ['a'] } },
    ] satisfies Action[]) {
      state = reducer(state, action)
    }
    const [ana] = teamWorkload(state, 't').members
    expect(ana.open.map((c) => c.title)).toEqual(['One', 'Two'])
    expect(ana.doneCount).toBe(1)
    expect(teamsForBoard(state, one).map((t) => t.id)).toEqual(['t'])
    expect(teamsForBoard(state, { cloud: { role: 'owner' } })).toEqual([])
  })
})
