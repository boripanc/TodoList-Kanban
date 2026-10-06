import { useState } from 'react'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Card, Column as ColumnType, Label } from '../types'
import { useStore } from '../state/context'
import { createId } from '../lib/id'
import { CardItem } from './CardItem'
import { Menu } from './Menu'

interface ColumnProps {
  boardId: string
  column: ColumnType
  cards: Card[]
  totalCount: number
  labels: Label[]
  onOpenCard: (cardId: string) => void
}

export function Column({ boardId, column, cards, totalCount, labels, onOpenCard }: ColumnProps) {
  const { dispatch } = useStore()
  const [editingTitle, setEditingTitle] = useState(false)
  const [composing, setComposing] = useState(false)
  const [draft, setDraft] = useState('')

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: column.id,
    data: { type: 'column' },
    disabled: editingTitle,
  })

  const overLimit = column.wipLimit > 0 && totalCount > column.wipLimit
  const atLimit = column.wipLimit > 0 && totalCount === column.wipLimit

  const addCard = () => {
    const title = draft.trim()
    if (!title) return
    dispatch({ type: 'card/add', columnId: column.id, id: createId(), title, now: Date.now() })
    setDraft('')
  }

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
          <h2 className="column-title" onDoubleClick={() => setEditingTitle(true)} title="Double-click to rename">
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
      </header>

      <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <ul className="card-list">
          {cards.map((card) => (
            <CardItem key={card.id} card={card} labels={labels} onOpen={onOpenCard} />
          ))}
          {cards.length === 0 && (
            <li className="column-empty">{totalCount > 0 ? 'No matching cards' : 'Drop cards here'}</li>
          )}
        </ul>
      </SortableContext>

      {composing ? (
        <div className="composer">
          <textarea
            autoFocus
            rows={2}
            value={draft}
            placeholder="Card title"
            aria-label="New card title"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                addCard()
              }
              if (e.key === 'Escape') {
                setComposing(false)
                setDraft('')
              }
            }}
          />
          <div className="composer-actions">
            <button className="button primary" onClick={addCard}>
              Add card
            </button>
            <button
              className="button ghost"
              onClick={() => {
                setComposing(false)
                setDraft('')
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button className="add-card" data-add-card onClick={() => setComposing(true)}>
          + Add card
        </button>
      )}
    </section>
  )
}
