import type { Board, Card, Column } from '../types'

/** Longest R4C or DD number kept. */
export const MAX_REF_LENGTH = 100

/** An R4C or DD number as stored: trimmed and capped. */
export function cleanRef(value: string): string {
  return value.trim().slice(0, MAX_REF_LENGTH)
}

/**
 * Boards made from the Project template hold interfaces to build: they have a
 * "Spec" column or cards with an interface spec. Other boards track R4C and
 * DD numbers on their cards instead.
 */
export function isProjectBoard(
  board: Pick<Board, 'columnIds'>,
  columns: Record<string, Pick<Column, 'title' | 'cardIds'> | undefined>,
  cards: Record<string, Pick<Card, 'spec'> | undefined>,
): boolean {
  return board.columnIds.some(
    (id) => columns[id]?.title.trim().toLowerCase() === 'spec' || columns[id]?.cardIds.some((c) => cards[c]?.spec),
  )
}

/** How a number reads on the card face: "R4C 1024", without doubling a prefix already typed ("R4C-1024"). */
export function refText(kind: 'R4C' | 'DD', value: string): string {
  return value.toUpperCase().startsWith(kind) ? value : `${kind} ${value}`
}
