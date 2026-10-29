import { useState } from 'react'
import { createPortal } from 'react-dom'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Card, Column as ColumnType, Label, TeamMember } from '../types'
import { useStore } from '../state/context'
import { CardItem } from './CardItem'
import { Menu } from './Menu'
import { NewCardDialog } from './NewCardDialog'
import { DONE_VISIBLE_LIMIT, isDoneColumn } from '../lib/done'

interface ColumnProps {
  boardId: string
  column: ColumnType
  cards: Card[]
  totalCount: number
  labels: Label[]
  team: TeamMember[]
  onOpenCard: (cardId: string) => void
  /** While searching or filtering, done columns show every match. */
  filterActive?: boolean
  /** The card being dragged, which stays in view even where older done cards fold away. */
  activeCardId?: string
  readOnly?: boolean
}

export function Column({
  boardId,
  column,
  cards,
  totalCount,
  labels,
  team,
  onOpenCard,
  filterActive = false,
  activeCardId,
  readOnly = false,
}: ColumnProps) {
  const { state, dispatch } = useStore()
  const board = state.boards[boardId]
  const [editingTitle, setEditingTitle] = useState(false)
  const [composing, setComposing] = useState(false)
  const [showOlder, setShowOlder] = useState(false)

  // Done columns keep only the last few finished cards in view; moves land at the bottom,
  // so the oldest are at the top. Hidden cards stay on the board. The card being dragged is
  // never folded away, so it can't vanish under the pointer.
  const olderCount =
    isDoneColumn(column.title) && !filterActive ? Math.max(0, cards.length - DONE_VISIBLE_LIMIT) : 0
  const settled = activeCardId ? cards.filter((card) => card.id !== activeCardId) : cards
  const hidden = new Set(olderCount > 0 && !showOlder ? settled.slice(0, olderCount).map((card) => card.id) : [])
  const shownCards = hidden.size > 0 ? cards.filter((card) => !hidden.has(card.id)) : cards

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: column.id,
    data: { type: 'column' },
    disabled: editingTitle || readOnly,
  })

  const overLimit = column.wipLimit > 0 && totalCount > column.wipLimit
  const atLimit = column.wipLimit > 0 && totalCount === column.wipLimit

  const rename = (title: string) => {
    dispatch({ type: 'column/update', columnId: column.id, patch: { title } })
    setEditingTitle(false)
  }

  return (
    <section
      ref={setNodeRef}
      className={`column ${isDragging ? 'is-dragging' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      aria-label={`Column: ${column.title}`}
    >
      <header className="column-header" {...attributes} {...listeners}>
        {editingTitle ? (
          <input
            className="column-title-input"
            defaultValue={column.title}
            autoFocus
            aria-label="Column title"
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') rename(e.currentTarget.value)
              if (e.key === 'Escape') setEditingTitle(false)
            }}
            onBlur={(e) => rename(e.currentTarget.value)}
          />
        ) : (
          <h2
            className="column-title"
            onDoubleClick={() => !readOnly && setEditingTitle(true)}
            title={readOnly ? undefined : 'Double-click to rename'}
          >
            {column.title}
          </h2>
        )}
        <span
          className={`column-count ${overLimit ? 'over-limit' : atLimit ? 'at-limit' : ''}`}
          title={column.wipLimit ? `Work-in-progress limit: ${column.wipLimit}` : 'Cards'}
        >
          {cards.length !== totalCount ? `${cards.length} of ${totalCount}` : totalCount}
          {column.wipLimit > 0 && ` / ${column.wipLimit}`}
        </span>
        {!readOnly && (
          <Menu
            label={`Column actions for ${column.title}`}
            items={[
              { label: 'Rename', onSelect: () => setEditingTitle(true) },
              {
                label: column.wipLimit ? `Change WIP limit (${column.wipLimit})` : 'Set WIP limit',
                onSelect: () => {
                  const value = window.prompt('Maximum cards in this column (0 for no limit)', String(column.wipLimit))
                  if (value !== null) {
                    dispatch({ type: 'column/update', columnId: column.id, patch: { wipLimit: Number(value) } })
                  }
                },
              },
              {
                label: 'Clear all cards',
                danger: true,
                onSelect: () => {
                  if (totalCount === 0 || window.confirm(`Delete all ${totalCount} cards in "${column.title}"?`)) {
                    dispatch({ type: 'column/clear', columnId: column.id })
                  }
                },
              },
              {
                label: 'Delete column',
                danger: true,
                onSelect: () => {
                  const message =
                    totalCount > 0
                      ? `Delete "${column.title}" and its ${totalCount} cards?`
                      : `Delete "${column.title}"?`
                  if (window.confirm(message)) dispatch({ type: 'column/delete', boardId, columnId: column.id })
                },
              },
            ]}
          >
            ⋯
          </Menu>
        )}
      </header>

      {olderCount > 0 && (
        <button
          className="older-toggle"
          aria-expanded={showOlder}
          onClick={() => setShowOlder((open) => !open)}
        >
          {showOlder ? 'Hide older cards' : `Show ${olderCount} older ${olderCount === 1 ? 'card' : 'cards'}`}
        </button>
      )}

      <SortableContext items={shownCards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <ul className="card-list">
          {shownCards.map((card) => (
            <CardItem key={card.id} card={card} labels={labels} team={team} onOpen={onOpenCard} readOnly={readOnly} />
          ))}
          {cards.length === 0 && (
            <li className="column-empty">
              {totalCount > 0 ? 'No matching cards' : readOnly ? 'No cards' : 'Drop cards here'}
            </li>
          )}
        </ul>
      </SortableContext>

      {!readOnly && (
        <button className="add-card" data-add-card onClick={() => setComposing(true)}>
          + Add card
        </button>
      )}
      {/* In a portal, so the column's layout and drag transform can't clip or shift the dialog. */}
      {composing &&
        board &&
        createPortal(<NewCardDialog board={board} column={column} onClose={() => setComposing(false)} />, document.body)}
    </section>
  )
}
