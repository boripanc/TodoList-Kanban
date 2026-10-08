// Which parts of a card are expanded on the board (progress updates, checklist).
// A per-device view preference, so each lives in its own localStorage key, not
// in the boards' state.
export type ExpandablePart = 'progress' | 'checklist'

const key = (part: ExpandablePart) => `todolist-kanban/${part}-expanded`

function read(part: ExpandablePart): Set<string> {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(key(part)) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

export function isExpanded(part: ExpandablePart, cardId: string): boolean {
  return read(part).has(cardId)
}

export function setExpanded(part: ExpandablePart, cardId: string, expanded: boolean) {
  const ids = read(part)
  if (expanded) ids.add(cardId)
  else ids.delete(cardId)
  try {
    globalThis.localStorage?.setItem(key(part), JSON.stringify([...ids]))
  } catch {
    // Storage blocked: the toggle still works until the page reloads.
  }
}
