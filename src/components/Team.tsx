import { useEffect, useState } from 'react'
import type { Board, Card, TeamMember } from '../types'
import { useStore } from '../state/context'
import { findBoardOfCard, findColumnOfCard } from '../state/reducer'
import { labelColors } from '../state/templates'
import { createId } from '../lib/id'
import { formatDue } from '../lib/dates'
import { UNASSIGNED } from '../lib/filter'
import {
  boardWorkload,
  initials,
  loadLevel,
  mergeWorkloads,
  type LoadLevel,
  type MemberLoad,
} from '../lib/workload'
import type { Cloud } from '../cloud/context'
import { ColorPicker } from './LabelEditor'
import { Modal } from './Modal'

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
  const openByMember = new Map(boardWorkload(state, board.id).members.map((m) => [m.key, m.open.length]))

  const add = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    const existing = board.team.find((m) => m.name.toLowerCase() === trimmed.toLowerCase())
    const id = existing?.id ?? createId()
    if (!existing) {
      const color = labelColors[board.team.length % labelColors.length]
      dispatch({ type: 'team/add', boardId: board.id, member: { id, name: trimmed, color, capacity: 0 } })
    }
    if (!card.assigneeIds.includes(id)) dispatch({ type: 'card/toggleAssignee', cardId: card.id, memberId: id, now: Date.now() })
    setName('')
  }

  return (
    <div className="field">
      <span>Assignees</span>
      {board.team.length === 0 && <small className="muted">No team yet. Add someone below.</small>}
      <div className="assignee-toggles">
        {board.team.map((member) => {
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

/** Each team member's open work, and editing the board's team. */
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
  const [scope, setScope] = useState<'board' | 'all'>('board')
  const [name, setName] = useState('')
  const [capacity, setCapacity] = useState('')
  const [color, setColor] = useState(labelColors[board.team.length % labelColors.length])
  const [access, setAccess] = useState<string[]>([])

  const boardsWithTeams = state.boardOrder.filter((id) => (state.boards[id]?.team.length ?? 0) > 0)
  const workload =
    scope === 'all'
      ? mergeWorkloads(boardsWithTeams.map((id) => boardWorkload(state, id)))
      : boardWorkload(state, board.id)
  const scale = Math.max(1, ...workload.members.map((m) => m.open.length))

  // People with access to an account board can be added in one click.
  useEffect(() => {
    if (!cloud?.user || !board.cloud) return
    let cancelled = false
    cloud.api
      .listMembers(board.id)
      .then((members) => !cancelled && setAccess(members.map((m) => m.email)))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [cloud, board.id, board.cloud])
  const taken = new Set(board.team.map((m) => m.name.toLowerCase()))
  const suggestions = access.map(nameFromEmail).filter((n) => n && !taken.has(n.toLowerCase()))

  const addMember = (memberName: string, memberCapacity = 0, memberColor = color) => {
    dispatch({
      type: 'team/add',
      boardId: board.id,
      member: { id: createId(), name: memberName, color: memberColor, capacity: memberCapacity },
    })
    setColor(labelColors[(board.team.length + 1) % labelColors.length])
  }

  return (
    <Modal title="Team and workload" onClose={onClose} wide>
      <h2>Team and workload</h2>
      {boardsWithTeams.length > 1 && (
        <div className="segmented" role="group" aria-label="Show workload for">
          <button type="button" className={`chip ${scope === 'board' ? 'on' : ''}`} aria-pressed={scope === 'board'} onClick={() => setScope('board')}>
            This board
          </button>
          <button type="button" className={`chip ${scope === 'all' ? 'on' : ''}`} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
            All boards
          </button>
        </div>
      )}
      {scope === 'all' && (
        <p className="muted small">People with the same name on different boards count as one person.</p>
      )}

      {workload.members.length === 0 ? (
        <p className="muted">
          No team on this board yet. Add the people you work with, then assign cards to them to see who has what.
        </p>
      ) : (
        <ul className="workload">
          {workload.members.map((load) => (
            <WorkloadRow
              key={load.key}
              load={load}
              scale={scale}
              showBoard={scope === 'all'}
              onOpenCard={onOpenCard}
              onShowOnBoard={scope === 'board' ? () => onShowOnBoard(load.key) : undefined}
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
            {scope === 'board' && workload.unassigned.length > 0 && (
              <div className="workload-actions">
                <button type="button" className="link" onClick={() => onShowOnBoard(UNASSIGNED)}>
                  Filter board
                </button>
              </div>
            )}
          </li>
        </ul>
      )}

      {scope === 'board' && !readOnly && (
        <section className="team-editor" aria-label="Edit team">
          <h3>Edit team</h3>
          <p className="muted small">
            Capacity is how many open cards someone can take on at once. Cards in a done column don't count. Leave it
            at 0 for no limit.
          </p>
          <ul>
            {board.team.map((member) => (
              <li key={member.id}>
                <Avatar person={member} />
                <input
                  defaultValue={member.name}
                  aria-label={`Name of ${member.name}`}
                  onBlur={(e) => {
                    const next = e.target.value.trim()
                    if (next && next !== member.name) {
                      dispatch({ type: 'team/update', boardId: board.id, memberId: member.id, patch: { name: next } })
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
                      dispatch({
                        type: 'team/update',
                        boardId: board.id,
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
                    dispatch({ type: 'team/update', boardId: board.id, memberId: member.id, patch: { color: next } })
                  }
                />
                <button
                  type="button"
                  className="icon-button danger"
                  aria-label={`Remove ${member.name} from the team`}
                  onClick={() => {
                    if (window.confirm(`Remove ${member.name} from the team? They will be taken off every card.`)) {
                      dispatch({ type: 'team/delete', boardId: board.id, memberId: member.id })
                    }
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
