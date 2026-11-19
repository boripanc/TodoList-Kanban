import { useEffect, useState } from 'react'
import type { Board, Card, TeamMember } from '../types'
import { useStore } from '../state/context'
import { findBoardOfCard, findColumnOfCard } from '../state/reducer'
import { labelColors } from '../state/templates'
import { createId } from '../lib/id'
import { formatDue } from '../lib/dates'
import { UNASSIGNED } from '../lib/filter'
import { boardWorkload, initials, loadLevel, teamWorkload, type LoadLevel, type MemberLoad } from '../lib/workload'
import { boardMembers, canEditTeam, sortedTeams, teamBoardIds, teamOfBoard, teamsForBoard } from '../lib/teams'
import type { Cloud } from '../cloud/context'
import { ColorPicker } from './LabelEditor'
import { Modal } from './Modal'
import { TeamCalendar, type CalendarView } from './TeamCalendar'
import { useAddToTeam } from './useAddToTeam'

type Person = Pick<TeamMember, 'name' | 'color'>

export function Avatar({ person, small }: { person: Person; small?: boolean }) {
  return (
    <span
      className={`avatar ${small ? 'avatar-small' : ''}`}
      style={{ '--avatar': person.color } as React.CSSProperties}
      title={person.name}
      aria-hidden
    >
      {initials(person.name)}
    </span>
  )
}

/** Overlapping avatars for a card's assignees, with "+N" past `max`. */
export function AvatarStack({ people, max = 3 }: { people: Person[]; max?: number }) {
  const shown = people.length > max ? people.slice(0, max - 1) : people
  const rest = people.length - shown.length
  return (
    <span
      className="avatar-stack"
      role="img"
      aria-label={`Assigned to ${people.map((p) => p.name).join(', ')}`}
      title={people.map((p) => p.name).join(', ')}
    >
      {shown.map((p, i) => (
        <Avatar key={i} person={p} small />
      ))}
      {rest > 0 && <span className="avatar avatar-small avatar-more">+{rest}</span>}
    </span>
  )
}

const viewOptions: ['list' | CalendarView, string][] = [
  ['list', 'List'],
  ['timeline', 'Timeline'],
  ['month', 'Month'],
]

const levelText: Record<LoadLevel, string> = {
  free: 'Free',
  busy: 'Has work',
  full: 'At capacity',
  over: 'Over capacity',
}


/** Pick who works on a card, in the card dialog. */
export function AssigneePicker({ board, card, readOnly }: { board: Board; card: Card; readOnly: boolean }) {
  const { state, dispatch } = useStore()
  const [name, setName] = useState('')
  const addToTeam = useAddToTeam(board)
  const team = boardMembers(state, board)
  // Open cards across all the team's boards, which is what capacity is about.
  const workload = board.teamId ? teamWorkload(state, board.teamId) : boardWorkload(state, board.id)
  const openByMember = new Map(workload.members.map((m) => [m.key, m.open.length]))

  const add = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    const id = addToTeam(trimmed)
    if (!card.assigneeIds.includes(id)) dispatch({ type: 'card/toggleAssignee', cardId: card.id, memberId: id, now: Date.now() })
    setName('')
  }

  return (
    <div className="field">
      <span>Assignees</span>
      {team.length === 0 && <small className="muted">No team yet. Add someone below.</small>}
      <div className="assignee-toggles">
        {team.map((member) => {
          const on = card.assigneeIds.includes(member.id)
          const open = openByMember.get(member.id) ?? 0
          const full = !on && member.capacity > 0 && open >= member.capacity
          const load = member.capacity > 0 ? `${open} of ${member.capacity} open cards` : `${open} open cards`
          return (
            <button
              key={member.id}
              type="button"
              className={`assignee-toggle ${on ? 'on' : ''} ${full ? 'full' : ''}`}
              aria-pressed={on}
              title={`${member.name}: ${load}${full ? ' (at capacity)' : ''}`}
              onClick={() => dispatch({ type: 'card/toggleAssignee', cardId: card.id, memberId: member.id, now: Date.now() })}
            >
              <Avatar person={member} small />
              {member.name}
              {full && <span className="assignee-full">full</span>}
            </button>
          )
        })}
      </div>
      {!readOnly && (
        <form className="new-label" onSubmit={add}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Add a person"
            aria-label="New team member name"
          />
          <button className="button" type="submit" disabled={!name.trim()}>
            Add
          </button>
        </form>
      )}
    </div>
  )
}

/** "ana.lee@example.com" → "Ana Lee". */
function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}

function WorkloadRow({
  load,
  scale,
  showBoard,
  onOpenCard,
  onShowOnBoard,
}: {
  load: MemberLoad<Card>
  /** Name each card's board, when cards come from several boards. */
  showBoard: boolean
  /** Open cards that fill the bar for someone without a capacity. */
  scale: number
  onOpenCard: (card: Card) => void
  onShowOnBoard?: () => void
}) {
  const { state } = useStore()
  const [open, setOpen] = useState(false)
  const level = loadLevel(load)
  const count = load.open.length
  const fill = load.capacity > 0 ? count / load.capacity : scale > 0 ? count / scale : 0
  const stats = [
    load.overdue > 0 && `${load.overdue} overdue`,
    load.dueSoon > 0 && `${load.dueSoon} due within a week`,
    `${load.doneCount} done`,
  ].filter(Boolean)
  return (
    <li className={`workload-row level-${level}`} aria-label={`Workload: ${load.name}`}>
      <div className="workload-head">
        <Avatar person={load} />
        <div className="workload-name">
          <strong>{load.name}</strong>
          <small className="muted">
            {load.capacity > 0 ? `${count} of ${load.capacity} open` : `${count} open`} · {stats.join(' · ')}
          </small>
        </div>
        <span className={`workload-level level-${level}`}>{levelText[level]}</span>
      </div>
      <div
        className="meter"
        role="meter"
        aria-label={`${load.name} load`}
        aria-valuemin={0}
        aria-valuemax={load.capacity || Math.max(scale, 1)}
        aria-valuenow={count}
      >
        <div className="meter-bar" style={{ width: `${Math.min(1, fill) * 100}%` }} />
      </div>
      <div className="workload-actions">
        {count > 0 && (
          <button type="button" className="link" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide cards' : `Show ${count} open card${count === 1 ? '' : 's'}`}
          </button>
        )}
        {onShowOnBoard && (
          <button type="button" className="link" onClick={onShowOnBoard}>
            Filter board
          </button>
        )}
      </div>
      {open && (
        <ul className="workload-cards">
          {load.open.map((card) => {
            const column = findColumnOfCard(state, card.id)
            const board = findBoardOfCard(state, card.id)
            return (
              <li key={card.id}>
                <button type="button" className="link" onClick={() => onOpenCard(card)}>
                  {card.title}
                </button>
                <small className="muted">
                  {' '}
                  {[showBoard ? board?.title : null, column?.title, card.dueDate && formatDue(card.dueDate)]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              </li>
            )
          })}
        </ul>
      )}
    </li>
  )
}

const NEW_TEAM = '__new'

/** Which team a board belongs to: pick one, leave it without, or start a new one. */
function BoardTeamPicker({ board, cloud }: { board: Board; cloud: Cloud | null }) {
  const { state, dispatch } = useStore()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const options = teamsForBoard(state, board)
  const current = teamOfBoard(state, board)
  // A board can sit in a team its person can't change (as a viewer); still show it.
  if (current && !options.includes(current)) options.unshift(current)

  const assignedCards = () =>
    board.columnIds.flatMap((c) => state.columns[c]?.cardIds ?? []).filter((id) => state.cards[id]?.assigneeIds.length)

  const choose = (value: string) => {
    if (value === NEW_TEAM) {
      setCreating(true)
      return
    }
    const teamId = value || null
    if (teamId === null && assignedCards().length > 0) {
      const ok = window.confirm('Take this board out of its team? Its cards will lose their assignees.')
      if (!ok) return
    }
    dispatch({ type: 'board/setTeam', boardId: board.id, teamId })
  }

  const create = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    const action = {
      type: 'team/create',
      id: createId(),
      name: trimmed,
      cloud: !!board.cloud,
      boardId: board.id,
      now: Date.now(),
    } as const
    if (cloud && action.cloud) cloud.createTeam(action)
    else dispatch(action)
    setCreating(false)
    setName('')
  }

  return (
    <div className="board-team">
      <label className="board-team-pick">
        <span>Team of “{board.title}”</span>
        <select value={creating ? NEW_TEAM : (board.teamId ?? '')} onChange={(e) => choose(e.target.value)}>
          <option value="">No team</option>
          {options.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
          <option value={NEW_TEAM}>+ New team…</option>
        </select>
      </label>
      {creating && (
        <form className="team-new" onSubmit={create} aria-label="New team">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Team name, e.g. Integration team"
            aria-label="New team name"
          />
          <button className="button primary" type="submit" disabled={!name.trim()}>
            Create team
          </button>
          <button type="button" className="button" onClick={() => setCreating(false)}>
            Cancel
          </button>
        </form>
      )}
    </div>
  )
}

/** A team's workload across all its boards, its boards, and editing the team. */
export function TeamDialog({
  board,
  readOnly,
  cloud,
  onClose,
  onOpenCard,
  onShowOnBoard,
}: {
  board: Board
  readOnly: boolean
  cloud: Cloud | null
  onClose: () => void
  /** Open a card, which may be on another board. */
  onOpenCard: (card: Card) => void
  /** Filter the board to one person's cards, or to unassigned ones. */
  onShowOnBoard: (memberId: string) => void
}) {
  const { state, dispatch } = useStore()
  const teams = sortedTeams(state)
  const [picked, setPicked] = useState<string | null>(null)
  // The board's own team unless another one was picked; a team that went away falls back to it.
  const teamId = picked && state.teams[picked] ? picked : board.teamId
  const team = teamId ? state.teams[teamId] : undefined
  const isBoardTeam = !!team && team.id === board.teamId
  const boardIds = team ? teamBoardIds(state, team.id) : []
  const [scope, setScope] = useState<'team' | 'board'>('team')
  const [view, setView] = useState<'list' | CalendarView>('list')
  const [name, setName] = useState('')
  const [capacity, setCapacity] = useState('')
  const members = team?.members ?? []
  const [color, setColor] = useState(labelColors[members.length % labelColors.length])
  const [access, setAccess] = useState<string[]>([])
  const addToTeam = useAddToTeam(board)

  const boardScope = isBoardTeam && scope === 'board' && boardIds.length > 1
  const workload = !team
    ? boardWorkload(state, board.id)
    : boardScope
      ? boardWorkload(state, board.id)
      : teamWorkload(state, team.id)
  const scale = Math.max(1, ...workload.members.map((m) => m.open.length))
  const editable = !readOnly && (!team || canEditTeam(team))
  const deletable = !!team && (!team.cloud || team.cloud.role === 'owner')
  const showBoard = !boardScope && boardIds.length > 1

  // People with access to an account board can be added in one click.
  useEffect(() => {
    if (!cloud?.user || !board.cloud) return
    let cancelled = false
    cloud.api
      .listMembers(board.id)
      .then((list) => !cancelled && setAccess(list.map((m) => m.email)))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [cloud, board.id, board.cloud])
  const taken = new Set(members.map((m) => m.name.toLowerCase()))
  const suggestions = isBoardTeam || !team ? access.map(nameFromEmail).filter((n) => n && !taken.has(n.toLowerCase())) : []

  const addMember = (memberName: string, memberCapacity = 0, memberColor = color) => {
    if (team) {
      dispatch({
        type: 'member/add',
        teamId: team.id,
        member: { id: createId(), name: memberName, color: memberColor, capacity: memberCapacity },
      })
    } else {
      addToTeam(memberName, { capacity: memberCapacity, color: memberColor })
    }
    setColor(labelColors[(members.length + 1) % labelColors.length])
  }

  return (
    <Modal title="Team and workload" onClose={onClose} wide>
      <h2>Team and workload</h2>
      {!readOnly && <BoardTeamPicker board={board} cloud={cloud} />}

      {(teams.length > 1 || (teams.length === 1 && !board.teamId)) && (
        <label className="team-show">
          <span>Show team</span>
          <select value={team?.id ?? ''} onChange={(e) => setPicked(e.target.value || null)} aria-label="Show workload of team">
            {!board.teamId && <option value="">This board (no team)</option>}
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.id === board.teamId ? ' (this board)' : ''}
              </option>
            ))}
          </select>
        </label>
      )}

      {team && (
        <div className="team-boards">
          <strong>{team.name}</strong>
          <span className="muted small">
            {boardIds.length === 0
              ? 'No boards yet'
              : `${boardIds.length} board${boardIds.length === 1 ? '' : 's'}: ${boardIds.map((id) => state.boards[id].title).join(', ')}`}
          </span>
        </div>
      )}

      <div className="team-views">
        {workload.members.length > 0 && (
          <div className="segmented" role="group" aria-label="View">
            {viewOptions.map(([value, text]) => (
              <button
                key={value}
                type="button"
                className={`chip ${view === value ? 'on' : ''}`}
                aria-pressed={view === value}
                onClick={() => setView(value)}
              >
                {text}
              </button>
            ))}
          </div>
        )}
        {isBoardTeam && boardIds.length > 1 && (
          <div className="segmented" role="group" aria-label="Show workload for">
            <button type="button" className={`chip ${!boardScope ? 'on' : ''}`} aria-pressed={!boardScope} onClick={() => setScope('team')}>
              All team boards
            </button>
            <button type="button" className={`chip ${boardScope ? 'on' : ''}`} aria-pressed={boardScope} onClick={() => setScope('board')}>
              This board
            </button>
          </div>
        )}
      </div>

      {workload.members.length === 0 ? (
        <p className="muted">
          {team
            ? 'Nobody on this team yet. Add the people you work with, then assign cards to them to see who has what.'
            : 'This board has no team yet. Add the people you work with and they become its team. Put your other boards in the same team to see everyone’s work across all of them.'}
        </p>
      ) : view !== 'list' ? (
        <TeamCalendar view={view} workload={workload} showBoard={showBoard} onOpenCard={onOpenCard} />
      ) : (
        <ul className="workload">
          {workload.members.map((load) => (
            <WorkloadRow
              key={load.key}
              load={load}
              scale={scale}
              showBoard={showBoard}
              onOpenCard={onOpenCard}
              onShowOnBoard={isBoardTeam || !team ? () => onShowOnBoard(load.key) : undefined}
            />
          ))}
          <li className="workload-row workload-unassigned" aria-label="Workload: Unassigned">
            <div className="workload-head">
              <span className="avatar avatar-empty" aria-hidden>
                ?
              </span>
              <div className="workload-name">
                <strong>Unassigned</strong>
                <small className="muted">
                  {workload.unassigned.length} open card{workload.unassigned.length === 1 ? '' : 's'} nobody has
                </small>
              </div>
            </div>
            {(isBoardTeam || !team) && workload.unassigned.length > 0 && (
              <div className="workload-actions">
                <button type="button" className="link" onClick={() => onShowOnBoard(UNASSIGNED)}>
                  Filter board
                </button>
              </div>
            )}
          </li>
        </ul>
      )}

      {editable && (
        <section className="team-editor" aria-label="Edit team">
          <h3>Edit team</h3>
          {team && (
            <div className="team-name-row">
              <input
                key={team.id}
                defaultValue={team.name}
                aria-label="Team name"
                onBlur={(e) => {
                  const next = e.target.value.trim()
                  if (next && next !== team.name) dispatch({ type: 'team/rename', teamId: team.id, name: next })
                }}
              />
              {deletable && (
                <button
                  type="button"
                  className="button danger"
                  onClick={() => {
                    const ok = window.confirm(
                      `Delete the team "${team.name}"? Its boards stay, without a team, and their cards lose their assignees.`,
                    )
                    if (!ok) return
                    if (cloud) cloud.deleteTeam(team.id)
                    else dispatch({ type: 'team/delete', teamId: team.id })
                    setPicked(null)
                  }}
                >
                  Delete team
                </button>
              )}
            </div>
          )}
          <p className="muted small">
            Capacity is how many open cards someone can take on at once, across all the team’s boards. Cards in a done
            column don't count. Leave it at 0 for no limit.
          </p>
          <ul>
            {members.map((member) => (
              <li key={member.id}>
                <Avatar person={member} />
                <input
                  defaultValue={member.name}
                  aria-label={`Name of ${member.name}`}
                  onBlur={(e) => {
                    const next = e.target.value.trim()
                    if (next && next !== member.name && team) {
                      dispatch({ type: 'member/update', teamId: team.id, memberId: member.id, patch: { name: next } })
                    }
                  }}
                />
                <label className="capacity-field">
                  <span>Capacity</span>
                  <input
                    type="number"
                    min={0}
                    max={999}
                    value={member.capacity}
                    aria-label={`Capacity of ${member.name}`}
                    onChange={(e) =>
                      team &&
                      dispatch({
                        type: 'member/update',
                        teamId: team.id,
                        memberId: member.id,
                        patch: { capacity: Number(e.target.value) || 0 },
                      })
                    }
                  />
                </label>
                <ColorPicker
                  label={`Color of ${member.name}`}
                  value={member.color}
                  onChange={(next) =>
                    team && dispatch({ type: 'member/update', teamId: team.id, memberId: member.id, patch: { color: next } })
                  }
                />
                <button
                  type="button"
                  className="icon-button danger"
                  aria-label={`Remove ${member.name} from the team`}
                  onClick={() => {
                    const ok = window.confirm(
                      `Remove ${member.name} from the team? They will be taken off every card on the team's boards.`,
                    )
                    if (ok && team) dispatch({ type: 'member/remove', teamId: team.id, memberId: member.id })
                  }}
                >
                  🗑
                </button>
              </li>
            ))}
          </ul>
          <form
            className="team-add"
            onSubmit={(e) => {
              e.preventDefault()
              const trimmed = name.trim()
              if (!trimmed) return
              addMember(trimmed, Number(capacity) || 0)
              setName('')
              setCapacity('')
            }}
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name"
              aria-label="New team member name"
            />
            <input
              type="number"
              min={0}
              max={999}
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              placeholder="Capacity"
              aria-label="New team member capacity"
            />
            <ColorPicker label="New team member color" value={color} onChange={setColor} />
            <button className="button primary" type="submit" disabled={!name.trim()}>
              Add to team
            </button>
          </form>
          {suggestions.length > 0 && (
            <div className="team-suggestions">
              <span className="muted small">People with access to this board:</span>
              {suggestions.map((n) => (
                <button key={n} type="button" className="chip" onClick={() => addMember(n)}>
                  + {n}
                </button>
              ))}
            </div>
          )}
        </section>
      )}
    </Modal>
  )
}
