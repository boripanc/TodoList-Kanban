import { afterEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { StoreProvider } from './state/store'
import { addBoardAction, createSampleState, loadState, STORAGE_KEY } from './state/storage'
import { CloudProvider } from './cloud/CloudProvider'
import type { CloudApi } from './cloud/api'
import { MemoryServer } from './cloud/memoryApi'
import { extractBoardDoc } from './cloud/doc'
import { initialState, reducer } from './state/reducer'

function renderApp() {
  return render(
    <StoreProvider initial={createSampleState()}>
      <App />
    </StoreProvider>,
  )
}

describe('App', () => {
  it('shows the sample work board with its columns', () => {
    renderApp()
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument()
    expect(screen.getByRole('main', { name: 'Board: Work' })).toBeInTheDocument()
    for (const title of ['Backlog', 'To do', 'In progress', 'Review', 'Done']) {
      expect(screen.getByRole('region', { name: `Column: ${title}` })).toBeInTheDocument()
    }
  })

  it('adds a card to a column', async () => {
    const user = userEvent.setup()
    renderApp()
    const backlog = screen.getByRole('region', { name: 'Column: Backlog' })
    await user.click(within(backlog).getByRole('button', { name: '+ Add card' }))
    await user.type(within(backlog).getByLabelText('New card title'), 'Call the bank{Enter}')
    expect(within(backlog).getByText('Call the bank')).toBeInTheDocument()
  })

  it('filters cards with search', async () => {
    const user = userEvent.setup()
    renderApp()
    await user.type(screen.getByLabelText('Search cards'), 'login')
    expect(screen.getByText('Fix login timeout')).toBeInTheDocument()
    expect(screen.queryByText('Plan next sprint')).not.toBeInTheDocument()
  })

  it('edits a card in the dialog and keeps the change after closing', async () => {
    const user = userEvent.setup()
    renderApp()
    await user.click(screen.getByText('Plan next sprint'))
    const dialog = screen.getByRole('dialog')
    const title = within(dialog).getByLabelText('Card title')
    await user.clear(title)
    await user.type(title, 'Plan Q4 sprint')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('Plan Q4 sprint')).toBeInTheDocument()
  })

  it('creates a new board from a template', async () => {
    const user = userEvent.setup()
    renderApp()
    await user.click(screen.getByRole('button', { name: '+ New board' }))
    await user.type(screen.getByPlaceholderText('e.g. Home renovation'), 'Trip')
    await user.click(screen.getByRole('radio', { name: /Daily life/ }))
    await user.click(screen.getByRole('button', { name: 'Create board' }))
    expect(screen.getByRole('main', { name: 'Board: Trip' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Column: Doing' })).toBeInTheDocument()
  })
})

describe('storage', () => {
  it('falls back to sample data when saved data is corrupt', () => {
    localStorage.setItem(STORAGE_KEY, '{not json')
    const state = loadState()
    expect(state.boardOrder.length).toBe(2)
  })
})

function renderWithCloud(api: CloudApi) {
  return render(
    <StoreProvider initial={createSampleState()}>
      <CloudProvider api={api}>
        <App />
      </CloudProvider>
    </StoreProvider>,
  )
}

/** A server where Ana owns a "Trip" board; returns it and the board id. */
async function serverWithTrip() {
  const server = new MemoryServer()
  const ana = server.addUser('ana@example.com')
  const add = addBoardAction('Trip', 'personal', 0)
  let state = reducer(initialState, add)
  const firstColumn = state.boards[add.id].columnIds[0]
  state = reducer(state, { type: 'card/add', columnId: firstColumn, id: 'c1', title: 'Pack bags', now: 0 })
  await server.client(ana).createBoard(extractBoardDoc(state, add.id)!)
  return { server, ana, boardId: add.id }
}

describe('accounts and sharing', () => {
  afterEach(() => window.history.replaceState(null, '', '/'))

  it('offers sign-in and sends a sign-in link', async () => {
    const user = userEvent.setup()
    renderWithCloud(new MemoryServer().client(null))
    await user.click(await screen.findByRole('button', { name: 'Sign in' }))
    await user.type(screen.getByLabelText('Email'), 'ana@example.com')
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
    expect(await screen.findByText(/We sent a sign-in link/)).toBeInTheDocument()
  })

  it('creates a board in the account and invites someone by email and by link', async () => {
    const user = userEvent.setup()
    const server = new MemoryServer()
    renderWithCloud(server.client(server.addUser('ana@example.com')))
    await screen.findByRole('button', { name: 'Account: ana@example.com' })

    await user.click(screen.getByRole('button', { name: '+ New board' }))
    await user.type(screen.getByPlaceholderText('e.g. Home renovation'), 'Trip')
    expect(screen.getByRole('radio', { name: /In my account/ })).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Create board' }))
    await waitFor(() => expect(server.boards.size).toBe(1))

    await user.click(screen.getByRole('button', { name: 'Board actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Share board…' }))
    const dialog = screen.getByRole('dialog', { name: 'Share board' })
    expect(await within(dialog).findByText('ana@example.com')).toBeInTheDocument()

    await user.type(within(dialog).getByLabelText('Email to invite'), 'ben@example.com')
    await user.click(within(dialog).getByRole('button', { name: 'Invite' }))
    expect(await within(dialog).findByText('ben@example.com')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Create link' }))
    const link = (await within(dialog).findByLabelText('Invite link, Can view')) as HTMLInputElement
    expect(link.value).toContain('?join=')
    expect(server.invites.map((i) => i.role).sort()).toEqual(['editor', 'viewer'])
  })

  it('moves a device board to the account before sharing it', async () => {
    const user = userEvent.setup()
    const server = new MemoryServer()
    renderWithCloud(server.client(server.addUser('ana@example.com')))
    await screen.findByRole('button', { name: 'Account: ana@example.com' })
    await user.click(screen.getByRole('button', { name: 'Board actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Share board…' }))
    await user.click(screen.getByRole('button', { name: 'Move to my account' }))
    expect(await screen.findByText('ana@example.com')).toBeInTheDocument()
    expect([...server.boards.values()].map((b) => b.title)).toEqual(['Work'])
    expect(server.cards.size).toBe(6)
  })

  it('accepts an invitation and opens the shared board', async () => {
    const user = userEvent.setup()
    const { server, ana, boardId } = await serverWithTrip()
    await server.client(ana).inviteByEmail(boardId, 'ben@example.com', 'editor')
    renderWithCloud(server.client(server.addUser('ben@example.com')))

    expect(await screen.findByText("You're invited to “Trip”.")).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'View' }))
    expect(screen.getByText(/From ana@example.com/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Accept' }))
    expect(await screen.findByRole('main', { name: 'Board: Trip' })).toBeInTheDocument()
    expect(screen.getByText('Pack bags')).toBeInTheDocument()
    expect(screen.queryByText(/You're invited/)).not.toBeInTheDocument()
  })

  it('joins with an invite link and shows a view-only board', async () => {
    const { server, ana, boardId } = await serverWithTrip()
    const token = await server.client(ana).createInviteLink(boardId, 'viewer')
    window.history.replaceState(null, '', `/?join=${token}`)
    renderWithCloud(server.client(server.addUser('cat@example.com')))

    expect(await screen.findByRole('main', { name: 'Board: Trip' })).toBeInTheDocument()
    expect(window.location.search).toBe('')
    expect(screen.getByText('You can view this board but not change it.')).toBeInTheDocument()
    expect(within(screen.getByRole('main')).queryByRole('button', { name: '+ Add card' })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Trip · can view' })).toBeInTheDocument()
  })

  it('asks a signed-out visitor with an invite link to sign in', async () => {
    window.history.replaceState(null, '', '/?join=abc')
    renderWithCloud(new MemoryServer().client(null))
    expect(await screen.findByText('Sign in to join the board you were invited to.', { exact: false })).toBeInTheDocument()
  })

  it('shows changes another member makes', async () => {
    const { server, ana, boardId } = await serverWithTrip()
    const anaApi = server.client(ana)
    await anaApi.inviteByEmail(boardId, 'ben@example.com', 'editor')
    const ben = server.addUser('ben@example.com')
    const benApi = server.client(ben)
    await benApi.acceptInvite((await benApi.listReceivedInvites())[0].id)
    renderWithCloud(benApi)
    await screen.findByRole('option', { name: 'Trip · can edit' })

    const doc = (await anaApi.fetchBoard(boardId))!
    await anaApi.applyOps(boardId, {
      board: { title: 'Trip to Japan', labels: doc.board.labels },
      upsertColumns: [],
      deleteColumnIds: [],
      upsertCards: [],
      deleteCardIds: [],
    })
    expect(await screen.findByRole('option', { name: 'Trip to Japan · can edit' })).toBeInTheDocument()
  })
})
