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
import { InvitesDialog, ShareDialog, SignInDialog } from './components/Sharing'
import { roleName } from './cloud/api'
import { useCloud } from './cloud/context'
import { isReadOnly } from './state/reducer'

export default function App() {
  const { state, dispatch } = useStore()
  const cloud = useCloud()
  const [filterState, setFilterState] = useState<{ boardId?: string; filter: CardFilter }>({
    filter: emptyFilter,
  })
  const [showFilters, setShowFilters] = useState(false)
  const [joinDismissed, setJoinDismissed] = useState(false)
  const [openCardId, setOpenCardId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<
    'new-board' | 'labels' | 'shortcuts' | 'share' | 'sign-in' | 'invites' | null
  >(null)
  const [theme, setTheme] = useState<Theme>(loadTheme)
  const searchRef = useRef<HTMLInputElement>(null)
  const importRef = useRef<HTMLInputElement>(null)

  const boardId =
    state.activeBoardId && state.boards[state.activeBoardId] ? state.activeBoardId : state.boardOrder[0]
  const board = boardId ? state.boards[boardId] : undefined
  const openCard = openCardId ? state.cards[openCardId] : undefined
  const readOnly = isReadOnly(board)
  const role = board?.cloud?.role
  const signedIn = !!cloud?.user
  const localIds = state.boardOrder.filter((id) => state.boards[id] && !state.boards[id].cloud)
  const cloudIds = state.boardOrder.filter((id) => state.boards[id]?.cloud)
  const boardOption = (id: string) => {
    const b = state.boards[id]
    const suffix = b.cloud && b.cloud.role !== 'owner' ? ` · ${roleName[b.cloud.role].toLowerCase()}` : ''
    return (
      <option key={id} value={id}>
        {b.title}
        {suffix}
      </option>
    )
  }
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
            {cloudIds.length > 0 ? (
              <>
                <optgroup label="On this device">{localIds.map(boardOption)}</optgroup>
                <optgroup label="In my account">{cloudIds.map(boardOption)}</optgroup>
              </>
            ) : (
              localIds.map(boardOption)
            )}
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
          {cloud && cloud.user === null && (
            <button className="button" onClick={() => setDialog('sign-in')}>
              Sign in
            </button>
          )}
          {cloud?.user && (
            <Menu
              label={`Account: ${cloud.user.email}`}
              triggerClassName="account-button"
              items={[
                {
                  label: `Invitations${cloud.invites.length ? ` (${cloud.invites.length})` : ''}`,
                  onSelect: () => setDialog('invites'),
                },
                {
                  label: `Sign out ${cloud.user.email}`,
                  onSelect: () => void cloud.signOut().catch(cloud.reportError),
                },
              ]}
            >
              {cloud.user.email.slice(0, 1).toUpperCase() || '?'}
              {cloud.invites.length > 0 && <span className="badge-dot" aria-hidden />}
            </Menu>
          )}
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
              ...(board && cloud
                ? [
                    {
                      label: role && role !== 'owner' ? 'Members…' : 'Share board…',
                      onSelect: () => setDialog(signedIn ? 'share' : 'sign-in'),
                    },
                  ]
                : []),
              ...(board && !readOnly
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
              ...(board && role && role !== 'owner'
                ? [
                    {
                      label: 'Leave board',
                      danger: true,
                      onSelect: () => {
                        if (window.confirm(`Leave "${board.title}"? You will need a new invite to join again.`)) {
                          void cloud?.leaveBoard(board.id).catch(cloud.reportError)
                        }
                      },
                    },
                  ]
                : board
                  ? [
                      {
                        label: 'Delete board',
                        danger: true,
                        onSelect: () => {
                          if (role === 'owner' && cloud) {
                            if (window.confirm(`Delete "${board.title}" for everyone it is shared with?`)) {
                              cloud.deleteBoard(board.id)
                            }
                          } else if (window.confirm(`Delete "${board.title}" and everything on it?`)) {
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

      {cloud && cloud.invites.length > 0 && (
        <div className="notice" role="status">
          {cloud.invites.length === 1
            ? `You're invited to “${cloud.invites[0].boardTitle}”.`
            : `You have ${cloud.invites.length} board invitations.`}
          <button className="link" onClick={() => setDialog('invites')}>
            View
          </button>
        </div>
      )}
      {board && readOnly && (
        <div className="notice" role="status">
          You can view this board but not change it.
        </div>
      )}
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
        <Board board={board} filter={filter} onOpenCard={setOpenCardId} readOnly={readOnly} />
      ) : (
        <div className="empty-state">
          <h2>No boards yet</h2>
          <p>Start with a template or a blank board.</p>
          <button className="button primary" onClick={() => setDialog('new-board')}>
            Create a board
          </button>
        </div>
      )}

      {board && openCard && (
        <CardModal board={board} card={openCard} readOnly={readOnly} onClose={() => setOpenCardId(null)} />
      )}

      {dialog === 'new-board' && (
        <NewBoardDialog
          canUseAccount={signedIn}
          onClose={() => setDialog(null)}
          onCreate={(title, template, inAccount) => {
            const action = addBoardAction(title, template)
            if (inAccount && cloud) cloud.createBoard(action)
            else dispatch(action)
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
      {cloud && (dialog === 'sign-in' || (cloud.pendingJoin && !joinDismissed && dialog === null)) && (
        <SignInDialog
          cloud={cloud}
          reason={cloud.pendingJoin ? 'Sign in to join the board you were invited to.' : undefined}
          onClose={() => {
            setDialog(null)
            setJoinDismissed(true)
          }}
        />
      )}
      {cloud && dialog === 'share' && board && (
        <ShareDialog cloud={cloud} board={board} onClose={() => setDialog(null)} />
      )}
      {cloud && dialog === 'invites' && <InvitesDialog cloud={cloud} onClose={() => setDialog(null)} />}
      {cloud?.error && (
        <div className="toast" role="alert">
          <span>{cloud.error}</span>
          <button className="icon-button" aria-label="Dismiss" onClick={cloud.clearError}>
            ✕
          </button>
        </div>
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
  canUseAccount,
  onClose,
  onCreate,
}: {
  canUseAccount: boolean
  onClose: () => void
  onCreate: (title: string, template: BoardTemplate, inAccount: boolean) => void
}) {
  const [title, setTitle] = useState('')
  const [template, setTemplate] = useState<BoardTemplate>('work')
  const [inAccount, setInAccount] = useState(canUseAccount)
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
          onCreate(title.trim() || templates.find((t) => t.value === template)!.name, template, inAccount)
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
        {canUseAccount && (
          <fieldset className="field">
            <legend>Keep it</legend>
            <label className="template-option">
              <input type="radio" name="where" checked={inAccount} onChange={() => setInAccount(true)} />
              <span>
                <strong>In my account</strong>
                <small className="muted">On all your devices, and you can share it</small>
              </span>
            </label>
            <label className="template-option">
              <input type="radio" name="where" checked={!inAccount} onChange={() => setInAccount(false)} />
              <span>
                <strong>On this device only</strong>
                <small className="muted">Private to this browser</small>
              </span>
            </label>
          </fieldset>
        )}
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
