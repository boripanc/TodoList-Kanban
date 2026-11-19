import type { Board, TeamMember } from '../types'
import { useStore } from '../state/context'
import { labelColors } from '../state/templates'
import { createId } from '../lib/id'
import { teamOfBoard } from '../lib/teams'
import { useCloud } from '../cloud/context'

/**
 * Add someone to a board's team by name, or find them if they are on it
 * already. A board without a team gets one, named after the board. Returns
 * their member id.
 */
export function useAddToTeam(board: Board) {
  const { getState, dispatch } = useStore()
  const cloud = useCloud()
  return (name: string, extra: Partial<Pick<TeamMember, 'capacity' | 'color'>> = {}): string => {
    const current = getState().boards[board.id] ?? board
    let team = teamOfBoard(getState(), current)
    if (!team) {
      const action = {
        type: 'team/create',
        id: createId(),
        name: `${current.title} team`,
        cloud: !!current.cloud,
        boardId: current.id,
        now: Date.now(),
      } as const
      if (cloud && action.cloud) cloud.createTeam(action)
      else dispatch(action)
      team = getState().teams[action.id]
    }
    const existing = team.members.find((m) => m.name.toLowerCase() === name.trim().toLowerCase())
    if (existing) return existing.id
    const id = createId()
    const color = extra.color ?? labelColors[team.members.length % labelColors.length]
    dispatch({ type: 'member/add', teamId: team.id, member: { id, name, color, capacity: extra.capacity ?? 0 } })
    return id
  }
}
