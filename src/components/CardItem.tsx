import { useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Card, Label } from '../types'
import { dueStatus, formatDue } from '../lib/dates'
import { priorityLabel } from '../lib/priority'
import { isProgressExpanded, setProgressExpanded } from '../lib/expanded'

interface CardViewProps {
  card: Card
  labels: Label[]
  overlay?: boolean
  /** Show the recent progress updates, not just the latest one. */
  expanded?: boolean
  onToggleProgress?: () => void
}

const shortDate = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

/** How many progress updates an expanded card shows. */
const RECENT_UPDATES = 3

function CardProgress({ card, expanded, onToggle }: { card: Card; expanded: boolean; onToggle?: () => void }) {
  const updates = card.progressLog.filter((e) => e.text).reverse()
  const shown = expanded ? updates.slice(0, RECENT_UPDATES) : updates.slice(0, 1)
  // Clicks and keys on the toggle shouldn't open the card or start a drag.
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  return (
    <div className="card-progress-section">
      {card.progress !== null && (
        <div
          className={`card-progress ${card.progress === 100 ? 'complete' : ''}`}
          role="progressbar"
          aria-label="Progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={card.progress}
        >
          <div className="progress">
            <div className="progress-bar" style={{ width: `${card.progress}%` }} />
          </div>
          <span>{card.progress}%</span>
        </div>
      )}
      {updates.length > 0 && (
        <div className="card-progress-notes">
          <ul aria-label="Latest progress">
            {shown.map((entry) => (
              <li key={entry.id} className={expanded ? undefined : 'clamp'}>
                {expanded && <span className="muted">{shortDate(entry.at)} · </span>}
                {entry.text}
              </li>
            ))}
          </ul>
          {updates.length > 1 && onToggle && (
            <button
              type="button"
              className="card-progress-toggle"
              aria-expanded={expanded}
              aria-label={expanded ? 'Hide progress updates' : 'Show progress updates'}
              onClick={(e) => {
                stop(e)
                onToggle()
              }}
              onPointerDown={stop}
              onKeyDown={stop}
            >
              {expanded
                ? '▴ Less'
                : `▾ ${Math.min(updates.length, RECENT_UPDATES)} ${updates.length > RECENT_UPDATES ? 'recent ' : ''}updates`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function CardView({ card, labels, overlay, expanded = false, onToggleProgress }: CardViewProps) {
  const cardLabels = labels.filter((label) => card.labelIds.includes(label.id))
  const doneCount = card.checklist.filter((item) => item.done).length
  const status = card.dueDate ? dueStatus(card.dueDate) : null
  const checklistDone = card.checklist.length > 0 && doneCount === card.checklist.length

  return (
    <div className={`card ${overlay ? 'card-overlay' : ''} priority-edge-${card.priority}`}>
      {cardLabels.length > 0 && (
        <div className="card-labels">
          {cardLabels.map((label) => (
            <span key={label.id} className="label-chip" style={{ '--label': label.color } as React.CSSProperties}>
              {label.name}
            </span>
          ))}
        </div>
      )}
      <div className="card-title">{card.title}</div>
      {(card.priority !== 'none' || card.dueDate || card.checklist.length > 0 || card.description) && (
        <div className="card-meta">
          {card.priority !== 'none' && (
            <span className={`badge priority-${card.priority}`} title="Priority">
              {priorityLabel[card.priority]}
            </span>
          )}
          {card.dueDate && (
            <span className={`badge due-${status}`} title={`Due ${card.dueDate}`}>
              📅 {formatDue(card.dueDate)}
            </span>
          )}
          {card.checklist.length > 0 && (
            <span className={`badge ${checklistDone ? 'checklist-done' : ''}`} title="Checklist">
              ☑ {doneCount}/{card.checklist.length}
            </span>
          )}
          {card.description && (
            <span className="badge badge-plain" title="Has notes" aria-label="Has notes">
              ≡
            </span>
          )}
        </div>
      )}
      {(card.progress !== null || card.progressLog.length > 0) && (
        <CardProgress card={card} expanded={expanded} onToggle={onToggleProgress} />
      )}
    </div>
  )
}

interface CardItemProps {
  card: Card
  labels: Label[]
  onOpen: (cardId: string) => void
  readOnly?: boolean
}

export function CardItem({ card, labels, onOpen, readOnly = false }: CardItemProps) {
  const [expanded, setExpanded] = useState(() => isProgressExpanded(card.id))
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { type: 'card' },
    disabled: readOnly,
  })

  return (
    <li
      ref={setNodeRef}
      className={`card-slot ${isDragging ? 'is-dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      aria-label={`Card: ${card.title}`}
      onClick={() => onOpen(card.id)}
      onKeyDown={(event) => {
        // Space starts a keyboard drag; Enter opens the card.
        if (event.key === 'Enter') onOpen(card.id)
        else listeners?.onKeyDown?.(event)
      }}
    >
      <CardView
        card={card}
        labels={labels}
        expanded={expanded}
        onToggleProgress={() => {
          setProgressExpanded(card.id, !expanded)
          setExpanded(!expanded)
        }}
      />
    </li>
  )
}
