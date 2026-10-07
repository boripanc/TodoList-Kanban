import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Card, Label } from '../types'
import { dueStatus, formatDue } from '../lib/dates'
import { priorityLabel } from '../lib/priority'


interface CardViewProps {
  card: Card
  labels: Label[]
  overlay?: boolean
}

export function CardView({ card, labels, overlay }: CardViewProps) {
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
      <CardView card={card} labels={labels} />
    </li>
  )
}
