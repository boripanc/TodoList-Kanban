import { useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  closestCorners,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, horizontalListSortingStrategy, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import type { Board as BoardType, Card, CardFilter } from '../types'
import { useStore } from '../state/context'
import { findColumnOfCard } from '../state/reducer'
import { matchesFilter } from '../lib/filter'
import { createId } from '../lib/id'
import { Column } from './Column'
import { CardView } from './CardItem'

interface BoardProps {
  board: BoardType
  filter: CardFilter
  onOpenCard: (cardId: string) => void
}

type ActiveDrag = { type: 'card' | 'column'; id: string } | null

export function Board({ board, filter, onOpenCard }: BoardProps) {
  const { state, dispatch } = useStore()
  const [active, setActive] = useState<ActiveDrag>(null)
  const [addingColumn, setAddingColumn] = useState(false)
  const lastDragEnd = useRef(0)

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    // On touch screens a short press-and-hold picks a card up, so swiping still scrolls.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
    }),
  )

  const visibleCards = useMemo(() => {
    const now = new Date()
    const result: Record<string, Card[]> = {}
    for (const columnId of board.columnIds) {
      const column = state.columns[columnId]
      if (!column) continue
      result[columnId] = column.cardIds
        .map((id) => state.cards[id])
        .filter((card): card is Card => !!card && matchesFilter(card, filter, now))
    }
    return result
  }, [board.columnIds, state.columns, state.cards, filter])

  // Columns only collide with columns; cards use corners so empty columns are reachable.
  const collisionDetection: CollisionDetection = (args) => {
    if (args.active.data.current?.type === 'column') {
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter((c) => c.data.current?.type === 'column'),
      })
    }
    return closestCorners(args)
  }

  /** The column a droppable belongs to: the column itself, or the column holding a card. */
  const columnForOver = (overId: string): string | undefined => {
    if (state.columns[overId] && board.columnIds.includes(overId)) return overId
    return findColumnOfCard(state, overId)?.id
  }

  const onDragStart = ({ active }: DragStartEvent) => {
    setActive({ type: active.data.current?.type === 'column' ? 'column' : 'card', id: String(active.id) })
  }

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over || active.data.current?.type !== 'card') return
    const cardId = String(active.id)
    const overId = String(over.id)
    const from = findColumnOfCard(state, cardId)
    const toColumnId = columnForOver(overId)
    if (!from || !toColumnId || from.id === toColumnId) return
    const target = state.columns[toColumnId]
    const overIndex = target.cardIds.indexOf(overId)
    let toIndex = target.cardIds.length
    if (overIndex >= 0) {
      const activeRect = active.rect.current.translated
      const below = activeRect && activeRect.top > over.rect.top + over.rect.height / 2
      toIndex = overIndex + (below ? 1 : 0)
    }
    dispatch({ type: 'card/move', cardId, toColumnId, toIndex })
  }

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setActive(null)
    lastDragEnd.current = Date.now()
    if (!over) return
    const activeId = String(active.id)
    const overId = String(over.id)

    if (active.data.current?.type === 'column') {
      const toColumnId = columnForOver(overId)
      if (!toColumnId || toColumnId === activeId) return
      dispatch({
        type: 'column/move',
        boardId: board.id,
        columnId: activeId,
        toIndex: board.columnIds.indexOf(toColumnId),
      })
      return
    }

    const column = findColumnOfCard(state, activeId)
    if (!column || activeId === overId) return
    const overIndex = column.cardIds.indexOf(overId)
    if (overIndex >= 0) {
      dispatch({ type: 'card/move', cardId: activeId, toColumnId: column.id, toIndex: overIndex })
    }
  }

  const openCard = (cardId: string) => {
    // A pointer release right after a drag also fires click; ignore it.
    if (Date.now() - lastDragEnd.current < 200) return
    onOpenCard(cardId)
  }

  const activeCard = active?.type === 'card' ? state.cards[active.id] : undefined
  const activeColumn = active?.type === 'column' ? state.columns[active.id] : undefined

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActive(null)}
    >
      <main className="board" aria-label={`Board: ${board.title}`}>
        <SortableContext items={board.columnIds} strategy={horizontalListSortingStrategy}>
          {board.columnIds.map((columnId) => {
            const column = state.columns[columnId]
            if (!column) return null
            return (
              <Column
                key={column.id}
                boardId={board.id}
                column={column}
                cards={visibleCards[column.id] ?? []}
                totalCount={column.cardIds.length}
                labels={board.labels}
                onOpenCard={openCard}
              />
            )
          })}
        </SortableContext>

        <div className="add-column">
          {addingColumn ? (
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault()
                const input = e.currentTarget.elements.namedItem('title') as HTMLInputElement
                if (!input.value.trim()) return
                dispatch({ type: 'column/add', boardId: board.id, id: createId(), title: input.value })
                input.value = ''
              }}
            >
              <input
                name="title"
                autoFocus
                placeholder="Column title"
                aria-label="New column title"
                onKeyDown={(e) => e.key === 'Escape' && setAddingColumn(false)}
              />
              <div className="composer-actions">
                <button className="button primary" type="submit">
                  Add column
                </button>
                <button className="button ghost" type="button" onClick={() => setAddingColumn(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button className="add-column-button" onClick={() => setAddingColumn(true)}>
              + Add column
            </button>
          )}
        </div>
      </main>

      <DragOverlay>
        {activeCard && <CardView card={activeCard} labels={board.labels} overlay />}
        {activeColumn && (
          <div className="column column-overlay">
            <header className="column-header">
              <h2 className="column-title">{activeColumn.title}</h2>
              <span className="column-count">{activeColumn.cardIds.length}</span>
            </header>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}
