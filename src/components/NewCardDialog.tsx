import { useState } from 'react'
import type { Board, Column, InterfaceSpec, MessageMode, Priority } from '../types'
import { useStore } from '../state/context'
import { createId } from '../lib/id'
import { todayISO } from '../lib/dates'
import { dueFromEstimate, MAX_ESTIMATE_DAYS, needsDateRange, scheduleProblem } from '../lib/schedule'
import { emptySpec, messageModes, modeName, specFields } from '../lib/interfaces'
import { priorityLabel } from '../lib/priority'
import { labelColors } from '../state/templates'
import { Modal } from './Modal'
import { NewLabelForm } from './LabelEditor'
import { Avatar } from './Team'
import { AdapterSelect } from './Interfaces'

const priorities: Priority[] = ['none', 'low', 'medium', 'high', 'urgent']

const hint = (key: (typeof specFields)[number]['key']) => specFields.find((f) => f.key === key)!.hint

/** Boards made from the Project template hold interfaces, so new cards there start with a spec. */
function holdsInterfaces(board: Board, columns: Record<string, Column>, cards: Record<string, { spec: unknown }>) {
  return board.columnIds.some(
    (id) => columns[id]?.title.trim().toLowerCase() === 'spec' || columns[id]?.cardIds.some((c) => cards[c]?.spec),
  )
}

/** The popup for adding a card to a column, with its details filled in up front. */
export function NewCardDialog({ board, column, onClose }: { board: Board; column: Column; onClose: () => void }) {
  const { state, dispatch } = useStore()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [labelIds, setLabelIds] = useState<string[]>([])
  const [assigneeIds, setAssigneeIds] = useState<string[]>([])
  const [person, setPerson] = useState('')
  const [priority, setPriority] = useState<Priority>('none')
  const [estimate, setEstimate] = useState('')
  const [startDate, setStartDate] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [dueTouched, setDueTouched] = useState(false)
  const [withSpec, setWithSpec] = useState(() => holdsInterfaces(board, state.columns, state.cards))
  const [spec, setSpec] = useState<InterfaceSpec>(() => emptySpec())
  const [tried, setTried] = useState(false)

  const labelNames = board.labels.filter((l) => labelIds.includes(l.id)).map((l) => l.name)
  const needsRange = needsDateRange(labelNames)
  const estimateDays = (() => {
    const n = estimate.trim() === '' ? null : Number(estimate)
    return n !== null && Number.isFinite(n) && n > 0 ? Math.min(n, MAX_ESTIMATE_DAYS) : null
  })()
  // Other cards' due date follows from the start date and estimate, unless typed by hand.
  const plannedDue = !needsRange && !dueTouched && startDate && estimateDays ? dueFromEstimate(startDate, estimateDays) : null
  const due = plannedDue ?? dueDate
  const dateProblem = scheduleProblem({ startDate: startDate || null, dueDate: due || null }, labelNames)
  const titleMissing = !title.trim()

  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])

  const addPerson = () => {
    const name = person.trim()
    if (!name) return
    const existing = board.team.find((m) => m.name.toLowerCase() === name.toLowerCase())
    const id = existing?.id ?? createId()
    if (!existing) {
      const color = labelColors[board.team.length % labelColors.length]
      dispatch({ type: 'team/add', boardId: board.id, member: { id, name, color, capacity: 0 } })
    }
    setAssigneeIds((ids) => (ids.includes(id) ? ids : [...ids, id]))
    setPerson('')
  }

  const create = () => {
    setTried(true)
    if (titleMissing || dateProblem) return
    const id = createId()
    const now = Date.now()
    dispatch({
      type: 'card/add',
      columnId: column.id,
      id,
      title,
      now,
      details: {
        description: description.trim() ? description : undefined,
        labelIds,
        assigneeIds,
        priority,
        startDate: startDate || null,
        dueDate: due || null,
        estimateDays,
        spec: withSpec ? spec : null,
      },
    })
    // Like a move: a card added straight into "In progress" starts today.
    dispatch({ type: 'card/startWork', cardId: id, today: todayISO(), now })
    onClose()
  }

  const setSpecField = (patch: Partial<InterfaceSpec>) => setSpec((s) => ({ ...s, ...patch }))

  return (
    <Modal title={`New card in ${column.title}`} onClose={onClose} wide>
      <div className="card-editor new-card">
        <h2 className="new-card-heading">New card in {column.title}</h2>
        <input
          className="card-editor-title"
          value={title}
          placeholder="Card title"
          aria-label="New card title"
          aria-invalid={tried && titleMissing}
          data-autofocus
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              create()
            }
          }}
        />
        {tried && titleMissing && (
          <small className="date-warning" role="alert">
            ⚠ Give the card a title.
          </small>
        )}

        <div className="card-editor-grid">
          <div className="card-editor-main">
            <label className="field">
              <span>Notes</span>
              <textarea
                rows={4}
                value={description}
                placeholder="Add more detail…"
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>

            <label className="new-card-check">
              <input type="checkbox" checked={withSpec} onChange={(e) => setWithSpec(e.target.checked)} />
              Interface to build (SAP CPI iFlow)
            </label>
            {withSpec && (
              <section className="spec-editor" aria-label="Interface spec">
                <div className="spec-editor-head">
                  <h3>Interface spec</h3>
                  <select
                    aria-label="Message mode"
                    value={spec.mode}
                    onChange={(e) => setSpecField({ mode: e.target.value as MessageMode })}
                  >
                    {messageModes.map((m) => (
                      <option key={m} value={m}>
                        {modeName[m]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="spec-route">
                  <fieldset className="field">
                    <legend>Sender</legend>
                    <input
                      value={spec.senderSystem}
                      placeholder={hint('senderSystem')}
                      aria-label="Sender system"
                      onChange={(e) => setSpecField({ senderSystem: e.target.value })}
                    />
                    <AdapterSelect
                      label="Sender adapter"
                      value={spec.senderAdapter}
                      onChange={(senderAdapter) => setSpecField({ senderAdapter })}
                    />
                  </fieldset>
                  <fieldset className="field">
                    <legend>Receiver</legend>
                    <input
                      value={spec.receiverSystem}
                      placeholder={hint('receiverSystem')}
                      aria-label="Receiver system"
                      onChange={(e) => setSpecField({ receiverSystem: e.target.value })}
                    />
                    <AdapterSelect
                      label="Receiver adapter"
                      value={spec.receiverAdapter}
                      onChange={(receiverAdapter) => setSpecField({ receiverAdapter })}
                    />
                  </fieldset>
                </div>
                <label className="field">
                  <span>iFlow / endpoint</span>
                  <input
                    className="mono"
                    value={spec.endpoint}
                    placeholder={hint('endpoint')}
                    onChange={(e) => setSpecField({ endpoint: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>Spec notes</span>
                  <textarea
                    className="mono"
                    rows={3}
                    value={spec.notes}
                    placeholder={hint('notes')}
                    onChange={(e) => setSpecField({ notes: e.target.value })}
                  />
                </label>
                {board.cloud && (
                  <small className="muted">Attach the technical and mapping spec files from the card once it is added.</small>
                )}
              </section>
            )}
          </div>

          <aside className="card-editor-side">
            <div className="field">
              <span>Labels</span>
              <div className="label-toggles">
                {board.labels.map((label) => (
                  <button
                    key={label.id}
                    type="button"
                    className={`label-chip toggle ${labelIds.includes(label.id) ? 'on' : ''}`}
                    style={{ '--label': label.color } as React.CSSProperties}
                    aria-pressed={labelIds.includes(label.id)}
                    onClick={() => setLabelIds(toggle(labelIds, label.id))}
                  >
                    {label.name}
                  </button>
                ))}
              </div>
              <NewLabelForm board={board} onCreated={(id) => setLabelIds((ids) => [...ids, id])} />
            </div>

            <div className="field">
              <span>Assignees</span>
              {board.team.length === 0 && <small className="muted">No team yet. Add someone below.</small>}
              <div className="assignee-toggles">
                {board.team.map((member) => {
                  const on = assigneeIds.includes(member.id)
                  return (
                    <button
                      key={member.id}
                      type="button"
                      className={`assignee-toggle ${on ? 'on' : ''}`}
                      aria-pressed={on}
                      onClick={() => setAssigneeIds(toggle(assigneeIds, member.id))}
                    >
                      <Avatar person={member} small />
                      {member.name}
                    </button>
                  )
                })}
              </div>
              <div className="new-label">
                <input
                  value={person}
                  placeholder="Add a person"
                  aria-label="New team member name"
                  onChange={(e) => setPerson(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addPerson()
                    }
                  }}
                />
                <button type="button" className="button" onClick={addPerson} disabled={!person.trim()}>
                  Add
                </button>
              </div>
            </div>

            <label className="field">
              <span>Priority</span>
              <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                {priorities.map((p) => (
                  <option key={p} value={p}>
                    {priorityLabel[p]}
                  </option>
                ))}
              </select>
            </label>

            <div className="field">
              <label htmlFor="new-estimate">Estimate (MD)</label>
              <input
                id="new-estimate"
                type="number"
                inputMode="decimal"
                min={0.5}
                max={MAX_ESTIMATE_DAYS}
                step={0.5}
                placeholder="Man-days"
                value={estimate}
                onChange={(e) => setEstimate(e.target.value)}
              />
              {!needsRange && (
                <small className="muted">
                  {startDate ? 'Due date is worked out from the start date and estimate (weekdays).' : 'Starts when the card moves to In progress.'}
                </small>
              )}
            </div>

            <div className="field">
              <label htmlFor="new-start-date">
                Start date{needsRange && <span className="required-mark"> (required)</span>}
              </label>
              <input
                id="new-start-date"
                type="date"
                value={startDate}
                max={due || undefined}
                required={needsRange}
                aria-invalid={needsRange && tried && !startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="new-due-date">
                {needsRange ? 'End date' : 'Due date'}
                {needsRange && <span className="required-mark"> (required)</span>}
              </label>
              <input
                id="new-due-date"
                type="date"
                value={due}
                min={startDate || undefined}
                required={needsRange}
                aria-invalid={needsRange && tried && !due}
                onChange={(e) => {
                  setDueTouched(true)
                  setDueDate(e.target.value)
                }}
              />
              {dateProblem && (needsRange ? tried : true) && (
                <small className="date-warning" role="alert">
                  ⚠ {dateProblem}
                </small>
              )}
            </div>
          </aside>
        </div>

        <div className="new-card-actions">
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={create}>
            Add card
          </button>
        </div>
      </div>
    </Modal>
  )
}
