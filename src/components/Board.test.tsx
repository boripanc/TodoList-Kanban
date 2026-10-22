import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { DragEndEvent, DragOverEvent, DragStartEvent } from '@dnd-kit/core'
import App from '../App'
import { StoreProvider } from '../state/store'
import { createSampleState } from '../state/storage'
import { reducer } from '../state/reducer'
import type { AppState } from '../types'

// jsdom has no layout, so drags are driven by calling the board's drag handlers directly,
// the way dnd-kit would.
let dnd: ComponentProps<typeof import('@dnd-kit/core').DndContext>
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>()
  return {
    ...actual,
    DndContext: (props: ComponentProps<typeof actual.DndContext>) => {
      dnd = props
      return <actual.DndContext {...props} />
    },
  }
})

const active = (id: string) =>
  ({ id, data: { current: { type: 'card' } }, rect: { current: { initial: null, translated: null } } }) as const

const over = (id: string) => ({
  id,
  rect: { top: 0, left: 0, width: 200, height: 40, bottom: 40, right: 200 },
  data: { current: {} },
  disabled: false,
})

function setup(doneCards = 0) {
  let state: AppState = createSampleState()
  const board = state.boards[state.activeBoardId!]
  const columnId = (title: string) => board.columnIds.find((id) => state.columns[id].title === title)!
  for (let i = 1; i <= doneCards; i++) {
    state = reducer(state, { type: 'card/add', columnId: columnId('Done'), id: `done-${i}`, title: `Finished ${i}`, now: 0 })
  }
  const cardId = (title: string) => Object.values(state.cards).find((card) => card.title === title)!.id
  render(
    <StoreProvider initial={state}>
      <App />
    </StoreProvider>,
  )
  const column = (title: string) => screen.getByRole('region', { name: `Column: ${title}` })
  return { cardId, columnId, column }
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))

const startDrag = (cardId: string) =>
  act(() => dnd.onDragStart?.({ active: active(cardId) } as unknown as DragStartEvent))

const dragOver = (cardId: string, overId: string) =>
  act(() => dnd.onDragOver?.({ active: active(cardId), over: over(overId) } as unknown as DragOverEvent))

const drop = (cardId: string, overId: string) =>
  act(() => dnd.onDragEnd?.({ active: active(cardId), over: over(overId) } as unknown as DragEndEvent))

describe('Board dragging', () => {
  it('does not flip a card back and forth between two columns before the screen updates', async () => {
    const { cardId, columnId, column } = setup()
    const card = cardId('Click a card to edit details')
    startDrag(card)

    // Covering Done's top card moves the card into Done.
    dragOver(card, cardId('Set up the board'))
    expect(within(column('Done')).getByText('Click a card to edit details')).toBeInTheDocument()

    // That shifts the layout so Review is under the pointer again. Moving straight back, and
    // forth again, on every render crashed React with error #185.
    dragOver(card, columnId('Review'))
    expect(within(column('Done')).getByText('Click a card to edit details')).toBeInTheDocument()

    // Once the browser has painted, the card follows the pointer again.
    await act(nextFrame)
    dragOver(card, columnId('Review'))
    expect(within(column('Review')).getByText('Click a card to edit details')).toBeInTheDocument()
  })

  it('drops a held-back card in the column it is dropped on', () => {
    const { cardId, columnId, column } = setup()
    const card = cardId('Click a card to edit details')
    startDrag(card)
    dragOver(card, cardId('Set up the board'))
    dragOver(card, columnId('Review'))
    drop(card, columnId('Review'))
    expect(within(column('Review')).getByText('Click a card to edit details')).toBeInTheDocument()
    expect(within(column('Done')).queryByText('Click a card to edit details')).not.toBeInTheDocument()
  })

  it('keeps a card dragged into a folded done column in view', () => {
    const { cardId, column } = setup(5)
    const card = cardId('Click a card to edit details')
    startDrag(card)
    // Done holds six cards, so its oldest is folded away and "Finished 1" is on top.
    dragOver(card, cardId('Finished 1'))
    const done = within(column('Done'))
    expect(done.getByText('Click a card to edit details')).toBeInTheDocument()
    expect(done.queryByText('Finished 1')).not.toBeInTheDocument()
    expect(done.getByText('Finished 5')).toBeInTheDocument()
  })
})
