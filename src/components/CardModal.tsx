import { useRef, useState } from 'react'
import type { Board, Card, Priority } from '../types'
import { useStore } from '../state/context'
import { findColumnOfCard } from '../state/reducer'
import { createId } from '../lib/id'
import { dueStatus, formatDue } from '../lib/dates'
import { needsDateRange, scheduleProblem } from '../lib/schedule'
import { Modal } from './Modal'
import { NewLabelForm } from './LabelEditor'
import { priorityLabel } from '../lib/priority'
import { ProgressEditor } from './ProgressEditor'
import { AssigneePicker } from './Team'

const priorities: Priority[] = ['none', 'low', 'medium', 'high', 'urgent']

export function CardModal({
  board,
  card,
  onClose,
  readOnly = false,
}: {
  board: Board
  card: Card
  onClose: () => void
  readOnly?: boolean
}) {
  const { state, dispatch } = useStore()
  const [newItem, setNewItem] = useState('')
  const [title, setTitle] = useState(card.title)
  const [description, setDescription] = useState(card.description)
  const column = findColumnOfCard(state, card.id)
  const startRef = useRef<HTMLInputElement>(null)
  const labelNames = board.labels.filter((l) => card.labelIds.includes(l.id)).map((l) => l.name)
  const needsRange = needsDateRange(labelNames)
  const dateProblem = scheduleProblem(card, labelNames)

  const update = (patch: Partial<Omit<Card, 'id' | 'createdAt'>>) =>
    dispatch({ type: 'card/update', cardId: card.id, patch, now: Date.now() })

  const toggleLabel = (labelId: string) => {
    const adding = !card.labelIds.includes(labelId)
    update({ labelIds: adding ? [...card.labelIds, labelId] : card.labelIds.filter((id) => id !== labelId) })
    // R4C and Project cards need a start and end date: take the person straight there.
    const label = board.labels.find((l) => l.id === labelId)
    if (adding && label && needsDateRange([label.name]) && (!card.startDate || !card.dueDate)) startRef.current?.focus()
  }

  const addChecklistItem = () => {
    const text = newItem.trim()
    if (!text) return
    update({ checklist: [...card.checklist, { id: createId(), text, done: false }] })
    setNewItem('')
  }

  // Text fields save on blur and when the dialog closes, so Escape never loses typing.
  const commitText = () => {
    const patch: Partial<Card> = {}
    if (title.trim() && title.trim() !== card.title) patch.title = title
    if (description !== card.description) patch.description = description
    if (Object.keys(patch).length > 0) update(patch)
  }

  const close = () => {
    commitText()
    onClose()
  }

  const doneCount = card.checklist.filter((i) => i.done).length
  const progress = card.checklist.length ? Math.round((doneCount / card.checklist.length) * 100) : 0

  return (
    <Modal title={`${readOnly ? 'Card' : 'Edit card'}: ${card.title}`} onClose={close} wide>
      <fieldset className="card-editor" disabled={readOnly}>
        <input
          className="card-editor-title"
          value={title}
          aria-label="Card title"
          data-autofocus
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />

        <div className="card-editor-grid">
          <div className="card-editor-main">
            <label className="field">
              <span>Notes</span>
              <textarea
                rows={5}
                value={description}
                placeholder="Add more detail…"
                onChange={(e) => setDescription(e.target.value)}
                onBlur={commitText}
              />
            </label>

            <div className="field">
              <span>
                Checklist {card.checklist.length > 0 && `(${doneCount}/${card.checklist.length})`}
              </span>
              {card.checklist.length > 0 && (
                <div className="progress" aria-label={`${progress}% complete`}>
                  <div className="progress-bar" style={{ width: `${progress}%` }} />
                </div>
              )}
              <ul className="checklist">
                {card.checklist.map((item) => (
                  <li key={item.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={item.done}
                        onChange={() =>
                          update({
                            checklist: card.checklist.map((i) => (i.id === item.id ? { ...i, done: !i.done } : i)),
                          })
                        }
                      />
                      <span className={item.done ? 'done' : undefined}>{item.text}</span>
                    </label>
                    <button
                      className="icon-button"
                      aria-label={`Remove ${item.text}`}
                      onClick={() => update({ checklist: card.checklist.filter((i) => i.id !== item.id) })}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
              <div className="checklist-add">
                <input
                  value={newItem}
                  placeholder="Add an item"
                  aria-label="New checklist item"
                  onChange={(e) => setNewItem(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addChecklistItem()}
                />
                <button className="button" onClick={addChecklistItem} disabled={!newItem.trim()}>
                  Add
                </button>
              </div>
            </div>

            <ProgressEditor card={card} />
          </div>

          <aside className="card-editor-side">
            <label className="field">
              <span>Column</span>
              <select
                value={column?.id}
                onChange={(e) => {
                  const target = state.columns[e.target.value]
                  dispatch({ type: 'card/move', cardId: card.id, toColumnId: target.id, toIndex: target.cardIds.length })
                }}
              >
                {board.columnIds.map((id) => (
                  <option key={id} value={id}>
                    {state.columns[id]?.title}
                  </option>
                ))}
              </select>
            </label>

            <AssigneePicker board={board} card={card} readOnly={readOnly} />

            <label className="field">
              <span>Priority</span>
              <select value={card.priority} onChange={(e) => update({ priority: e.target.value as Priority })}>
                {priorities.map((p) => (
                  <option key={p} value={p}>
                    {priorityLabel[p]}
                  </option>
                ))}
              </select>
            </label>

            <div className="field">
              <label htmlFor="start-date">
                Start date{needsRange && <span className="required-mark"> (required)</span>}
              </label>
              <div className="due-row">
                <input
                  id="start-date"
                  ref={startRef}
                  type="date"
                  value={card.startDate ?? ''}
                  max={card.dueDate ?? undefined}
                  required={needsRange}
                  aria-invalid={needsRange && !card.startDate}
                  onChange={(e) => update({ startDate: e.target.value || null })}
                />
                {card.startDate && (
                  <button
                    className="icon-button"
                    aria-label="Clear start date"
                    onClick={() => update({ startDate: null })}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            <div className="field">
              <label htmlFor="due-date">
                {needsRange ? 'End date' : 'Due date'}
                {needsRange && <span className="required-mark"> (required)</span>}
              </label>
              <div className="due-row">
                <input
                  id="due-date"
                  type="date"
                  value={card.dueDate ?? ''}
                  min={card.startDate ?? undefined}
                  required={needsRange}
                  aria-invalid={needsRange && !card.dueDate}
                  onChange={(e) => update({ dueDate: e.target.value || null })}
                />
                {card.dueDate && (
                  <button
                    className="icon-button"
                    aria-label={needsRange ? 'Clear end date' : 'Clear due date'}
                    onClick={() => update({ dueDate: null })}
                  >
                    ✕
                  </button>
                )}
              </div>
              {card.dueDate && (
                <small className={`due-hint due-${dueStatus(card.dueDate)}`}>{formatDue(card.dueDate)}</small>
              )}
              {dateProblem && (
                <small className="date-warning" role="alert">
                  ⚠ {dateProblem}
                </small>
              )}
            </div>

            <div className="field">
              <span>Labels</span>
              <div className="label-toggles">
                {board.labels.map((label) => (
                  <button
                    key={label.id}
                    className={`label-chip toggle ${card.labelIds.includes(label.id) ? 'on' : ''}`}
                    style={{ '--label': label.color } as React.CSSProperties}
                    aria-pressed={card.labelIds.includes(label.id)}
                    onClick={() => toggleLabel(label.id)}
                  >
                    {label.name}
                  </button>
                ))}
              </div>
              <NewLabelForm board={board} onCreated={(id) => update({ labelIds: [...card.labelIds, id] })} />
            </div>

            {!readOnly && (
              <div className="card-editor-actions">
                <button
                  className="button"
                  onClick={() => {
                    commitText()
                    dispatch({ type: 'card/duplicate', cardId: card.id, newId: createId(), now: Date.now() })
                    onClose()
                  }}
                >
                  Duplicate
                </button>
                <button
                  className="button danger"
                  onClick={() => {
                    if (window.confirm(`Delete "${card.title}"?`)) {
                      dispatch({ type: 'card/delete', cardId: card.id })
                      onClose()
                    }
                  }}
                >
                  Delete
                </button>
              </div>
            )}
            <p className="muted small">
              Created {new Date(card.createdAt).toLocaleString()}
              <br />
              Updated {new Date(card.updatedAt).toLocaleString()}
            </p>
          </aside>
        </div>
      </fieldset>
    </Modal>
  )
}
