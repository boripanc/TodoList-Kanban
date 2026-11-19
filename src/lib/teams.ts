import type { AppState, Board, Team, TeamMember } from '../types'

/** The team a board belongs to, if any. */
export function teamOfBoard(state: Pick<AppState, 'teams'>, board: Pick<Board, 'teamId'> | undefined): Team | undefined {
  return board?.teamId ? state.teams[board.teamId] : undefined
}

/** The people cards on a board can be assigned to: its team's members. */
export function boardMembers(state: Pick<AppState, 'teams'>, board: Pick<Board, 'teamId'> | undefined): TeamMember[] {
  return teamOfBoard(state, board)?.members ?? []
}

/** The boards in a team, in board order. */
export function teamBoardIds(state: Pick<AppState, 'boardOrder' | 'boards'>, teamId: string): string[] {
  return state.boardOrder.filter((id) => state.boards[id]?.teamId === teamId)
}

/** Teams by name. */
export function sortedTeams(state: Pick<AppState, 'teams'>): Team[] {
  return Object.values(state.teams).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** Whether someone may change the team: anyone but a viewer. */
export function canEditTeam(team: Pick<Team, 'cloud'> | undefined): boolean {
  return !!team && team.cloud?.role !== 'viewer'
}

/**
 * Teams a board can join: ones that live in the same place (the account or
 * this device) and that the person may change.
 */
export function teamsForBoard(state: Pick<AppState, 'teams'>, board: Pick<Board, 'cloud'>): Team[] {
  return sortedTeams(state).filter((team) => !!team.cloud === !!board.cloud && canEditTeam(team))
}

/**
 * Bring the people assigned to cards over to another team, when a board
 * moves to it. Each person is matched in the target team by id, then by name
 * (ignoring case); anyone it doesn't have yet joins it. Returns the target's
 * members afterwards and the new id for each old one. Ids not on the source
 * team are left out of the map.
 */
export function carryMembers(
  source: TeamMember[],
  target: TeamMember[],
  usedIds: Iterable<string>,
): { members: TeamMember[]; map: Map<string, string> } {
  const members = [...target]
  const map = new Map<string, string>()
  for (const id of usedIds) {
    if (map.has(id)) continue
    const person = source.find((m) => m.id === id)
    if (!person) continue
    const key = person.name.trim().toLowerCase()
    const match = members.find((m) => m.id === id) ?? members.find((m) => m.name.trim().toLowerCase() === key)
    if (match) {
      map.set(id, match.id)
      continue
    }
    members.push({ ...person })
    map.set(id, person.id)
  }
  return { members, map }
}

/**
 * Join several boards' teams into one, matching people by name (ignoring
 * case). The first one seen keeps their id and color; capacity is the largest
 * one set. Returns the joined members and, for each team given, the new id of
 * each of its people.
 */
export function mergeMembers(teams: TeamMember[][]): { members: TeamMember[]; maps: Map<string, string>[] } {
  const members: TeamMember[] = []
  const maps = teams.map((team) => {
    const map = new Map<string, string>()
    for (const person of team) {
      const key = person.name.trim().toLowerCase()
      const index = members.findIndex((m) => m.name.trim().toLowerCase() === key)
      if (index < 0) {
        // Two boards could hold the same id for different people; give the second one its own.
        const id = members.some((m) => m.id === person.id) ? `${person.id}-${members.length}` : person.id
        members.push({ ...person, id })
        map.set(person.id, id)
        continue
      }
      const kept = members[index]
      if (person.capacity > kept.capacity) members[index] = { ...kept, capacity: person.capacity }
      map.set(person.id, kept.id)
    }
    return map
  })
  return { members, maps }
}

/** Card assignee ids after `map`, in order and without repeats; ids not in the map stay as they were. */
export function remapIds(ids: string[], map: Map<string, string>): string[] {
  return [...new Set(ids.map((id) => map.get(id) ?? id))]
}
