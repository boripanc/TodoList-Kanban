import { useEffect, useRef, useState } from 'react'
import type { CardFilter } from './types'
import { useStore } from './state/context'
import { addBoardAction } from './state/storage'
import type { BoardTemplate } from './state/templates'
import { emptyFilter, isFilterActive } from './lib/filter'
import { applyTheme, loadTheme, nextTheme, themeIcon, type Theme } from './lib/theme'
import { downloadBackup, readBackup } from './lib/backup'
import { Board } from './components/Board'
import { CardModal } from './components/CardModal'
import { FilterBar } from './components/FilterBar'
import { LabelManager } from './components/LabelEditor'
import { Menu } from './components/Menu'
import { Modal } from './components/Modal'

export default function App() {
  const { state, dispatch } = useStore()
  const [filterState, setFilterState] = useState<{ boardId?: string; filter: CardFilter }>({
    filter: emptyFilter,
  })
  const [showFilters, setShowFilters] = useState(false)
  const [openCardId, setOpenCardId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'new-board' | 'labels' | 'shortcuts' | null>(null)
  const [theme, setTheme] = useState<Theme>(loadTheme)
  const searchRef = useRef<HTMLInputElement>(null)
  const importRef = useRef<HTMLInputElement>(null)

  const boardId =
    state.activeBoardId && state.boards[state.activeBoardId] ? state.activeBoardId : state.boardOrder[0]
  const board = boardId ? state.boards[boardId] : undefined
  const openCard = openCardId ? state.cards[openCardId] : undefined
  // Filters belong to one board; switching boards starts unfiltered.
  const filter = filterState.boardId === boardId ? filterState.filter : emptyFilter
  const setFilter = (next: CardFilter) => setFilterState({ boardId, filter: next })

  useEffect(() => applyTheme(theme), [theme])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      const typing = target.closest('input, textarea, select, [contenteditable="true"]')
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return
      if (document.querySelector('[role="dialog"]')) return
      if (event.key === '/') {
        event.preventDefault()
        searchRef.current?.focus()
      } else if (event.key === 'n' || event.key === 'N') {
        event.preventDefault()
        document.querySelector<HTMLButtonElement>('[data-add-card]')?.click()
      } else if (event.key === 'f' || event.key === 'F') {
        setShowFilters((v) => !v)
      } else if (event.key === '?') {
        setDialog('shortcuts')
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const activeFilterCount =
    filter.labelIds.length + filter.priorities.length + (filter.due !== 'any' ? 1 : 0)

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" aria-hidden>
          ▦
        </div>
        {board ? (
          <select
            className="board-select"
            aria-label="Current board"
            value={board.id}
            onChange={(e) => dispatch({ type: 'board/select', boardId: e.target.value })}
          >
            {state.boardOrder.map((id) => (
              <option key={id} value={id}>
                {state.boards[id]?.title}
              </option>
            ))}
          </select>
        ) : (
          <h1 className="board-select">Kanban</h1>
        )}
        <button className="button" onClick={() => setDialog('new-board')}>
          + New board
        </button>

        {board && (
          <>
            <div className="search">
              <input
                ref={searchRef}
                type="search"
                placeholder="Search cards  ( / )"
                aria-label="Search cards"
                value={filter.query}
                onChange={(e) => setFilter({ ...filter, query: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setFilter({ ...filter, query: '' })
                    e.currentTarget.blur()
                  }
                }}
              />
            </div>
            <button
              className={`button ${showFilters || activeFilterCount ? 'active' : ''}`}
              aria-expanded={showFilters}
              onClick={() => setShowFilters((v) => !v)}
            >
              Filter{activeFilterCount > 0 && ` (${activeFilterCount})`}
            </button>
          </>
        )}

        <div className="topbar-end">
          <button
            className="icon-button"
            aria-label={`Theme: ${theme}. Switch to ${nextTheme[theme]}`}
            title={`Theme: ${theme}`}
            onClick={() => setTheme(nextTheme[theme])}
          >
            {themeIcon[theme]}
          </button>
          <Menu
            label="Board actions"
            items={[
              ...(board
                ? [
                    {
                      label: 'Rename board',
                      onSelect: () => {
                        const title = window.prompt('Board name', board.title)
                        if (title) dispatch({ type: 'board/rename', boardId: board.id, title })
                      },
                    },
                    { label: 'Manage labels', onSelect: () => setDialog('labels') },
                  ]
                : []),
              { label: 'Export backup (JSON)', onSelect: () => downloadBackup(state) },
              { label: 'Import backup…', onSelect: () => importRef.current?.click() },
              { label: 'Keyboard shortcuts', onSelect: () => setDialog('shortcuts') },
              ...(board
                ? [
                    {
                      label: 'Delete board',
                      danger: true,
                      onSelect: () => {
                        if (window.confirm(`Delete "${board.title}" and everything on it?`)) {
                          dispatch({ type: 'board/delete', boardId: board.id })
                        }
                      },
                    },
                  ]
                : []),
            ]}
          >
            ⋯
          </Menu>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (!file) return
              try {
                const imported = await readBackup(file)
                if (window.confirm('Replace all boards with this backup?')) {
                  dispatch({ type: 'state/replace', state: imported })
                }
              } catch (error) {
                window.alert(error instanceof Error ? error.message : 'Could not read that file.')
              }
            }}
          />
        </div>
      </header>

      {board && showFilters && <FilterBar board={board} filter={filter} onChange={setFilter} />}
      {board && isFilterActive(filter) && !showFilters && (
        <div className="filter-note">
          Showing filtered cards.{' '}
          <button className="link" onClick={() => setFilter(emptyFilter)}>
            Clear
          </button>
        </div>
      )}

      {board ? (
        <Board board={board} filter={filter} onOpenCard={setOpenCardId} />
      ) : (
        <div className="empty-state">
          <h2>No boards yet</h2>
          <p>Start with a template or a blank board.</p>
          <button className="button primary" onClick={() => setDialog('new-board')}>
            Create a board
          </button>
        </div>
      )}

      {board && openCard && <CardModal board={board} card={openCard} onClose={() => setOpenCardId(null)} />}

      {dialog === 'new-board' && (
        <NewBoardDialog
          onClose={() => setDialog(null)}
          onCreate={(title, template) => {
            dispatch(addBoardAction(title, template))
            setDialog(null)
          }}
        />
      )}
      {dialog === 'labels' && board && (
        <Modal title="Manage labels" onClose={() => setDialog(null)}>
          <h2>Labels</h2>
          <LabelManager board={board} />
        </Modal>
      )}
      {dialog === 'shortcuts' && (
        <Modal title="Keyboard shortcuts" onClose={() => setDialog(null)}>
          <h2>Keyboard shortcuts</h2>
          <dl className="shortcuts">
            <dt>/</dt>
            <dd>Search cards</dd>
            <dt>N</dt>
            <dd>Add a card to the first column</dd>
            <dt>F</dt>
            <dd>Show or hide filters</dd>
            <dt>Enter</dt>
            <dd>Open the focused card</dd>
            <dt>Space</dt>
            <dd>Pick up a focused card or column, move with arrows, Space to drop</dd>
            <dt>Esc</dt>
            <dd>Close a dialog or cancel a drag</dd>
            <dt>?</dt>
            <dd>Show this list</dd>
          </dl>
        </Modal>
      )}
    </div>
  )
}

function NewBoardDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (title: string, template: BoardTemplate) => void
}) {
  const [title, setTitle] = useState('')
  const [template, setTemplate] = useState<BoardTemplate>('work')
  const templates: { value: BoardTemplate; name: string; detail: string }[] = [
    { value: 'work', name: 'Work', detail: 'Backlog, To do, In progress, Review, Done' },
    { value: 'personal', name: 'Daily life', detail: 'To do, Doing, Done' },
    { value: 'blank', name: 'Blank', detail: 'No columns' },
  ]
  return (
    <Modal title="New board" onClose={onClose}>
      <form
        className="new-board"
        onSubmit={(e) => {
          e.preventDefault()
          onCreate(title.trim() || templates.find((t) => t.value === template)!.name, template)
        }}
      >
        <h2>New board</h2>
        <label className="field">
          <span>Name</span>
          <input data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Home renovation" />
        </label>
        <fieldset className="field">
          <legend>Template</legend>
          {templates.map((t) => (
            <label key={t.value} className="template-option">
              <input
                type="radio"
                name="template"
                checked={template === t.value}
                onChange={() => setTemplate(t.value)}
              />
              <span>
                <strong>{t.name}</strong>
                <small className="muted">{t.detail}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="composer-actions">
          <button className="button primary" type="submit">
            Create board
          </button>
          <button className="button ghost" type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  )
}
