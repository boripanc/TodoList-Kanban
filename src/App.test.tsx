import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { StoreProvider } from './state/store'
import { createSampleState, loadState, STORAGE_KEY } from './state/storage'

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
