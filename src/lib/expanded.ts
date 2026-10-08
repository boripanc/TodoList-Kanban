// Which cards show their recent progress updates on the board. A per-device view
// preference, so it lives in its own localStorage key, not in the boards' state.
const KEY = 'todolist-kanban/progress-expanded'

function read(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

export function isProgressExpanded(cardId: string): boolean {
  return read().has(cardId)
}

export function setProgressExpanded(cardId: string, expanded: boolean) {
  const ids = read()
  if (expanded) ids.add(cardId)
  else ids.delete(cardId)
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify([...ids]))
  } catch {
    // Storage blocked: the toggle still works until the page reloads.
  }
}
