import { afterEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { StoreProvider } from './state/store'
import { addBoardAction, createSampleState, loadState, STORAGE_KEY } from './state/storage'
import { CloudProvider } from './cloud/CloudProvider'
import type { CloudApi } from './cloud/api'
import { MemoryServer } from './cloud/memoryApi'
import { UnreachableError } from './cloud/serverApi'
import { extractBoardDoc } from './cloud/doc'
import { initialState, reducer } from './state/reducer'
import { todayISO } from './lib/dates'
import { dueFromEstimate } from './lib/schedule'
import { emptySpec } from './lib/interfaces'

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
    const dialog = screen.getByRole('dialog', { name: 'New card in Backlog' })
    await user.type(within(dialog).getByLabelText('New card title'), 'Call the bank{Enter}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(within(backlog).getByText('Call the bank')).toBeInTheDocument()
  })

  it('fills in a new card in the popup: labels, assignees, priority, estimate and dates', async () => {
    const user = userEvent.setup()
    renderApp()
    const todo = screen.getByRole('region', { name: 'Column: To do' })
    await user.click(within(todo).getByRole('button', { name: '+ Add card' }))
    const dialog = screen.getByRole('dialog', { name: 'New card in To do' })
    await user.type(within(dialog).getByLabelText('New card title'), 'Fix login')
    await user.type(within(dialog).getByLabelText('Notes'), 'Fails on Safari')
    await user.click(within(dialog).getByRole('button', { name: 'Bug' }))
    await user.type(within(dialog).getByLabelText('New team member name'), 'Ana{Enter}')
    await user.selectOptions(within(dialog).getByLabelText('Priority'), 'high')
    await user.type(within(dialog).getByLabelText('Estimate (MD)'), '3')
    fireEvent.change(within(dialog).getByLabelText('Start date'), { target: { value: '2026-11-05' } })
    expect(within(dialog).getByLabelText('Due date')).toHaveValue(dueFromEstimate('2026-11-05', 3))
    await user.click(within(dialog).getByRole('button', { name: 'Add card' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(within(todo).getByText('Fix login'))
    const editor = screen.getByRole('dialog', { name: 'Edit card: Fix login' })
    expect(within(editor).getByLabelText('Notes')).toHaveValue('Fails on Safari')
    expect(within(editor).getByRole('button', { name: 'Bug' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(editor).getByRole('button', { name: /Ana/ })).toHaveAttribute('aria-pressed', 'true')
    expect(within(editor).getByLabelText('Priority')).toHaveValue('high')
    expect(within(editor).getByLabelText('Start date')).toHaveValue('2026-11-05')
    expect(within(editor).getByLabelText('Due date')).toHaveValue(dueFromEstimate('2026-11-05', 3))
  })

  it('asks for start and end dates before adding an R4C card, and drops a cancelled card', async () => {
    const user = userEvent.setup()
    renderApp()
    const backlog = screen.getByRole('region', { name: 'Column: Backlog' })
    await user.click(within(backlog).getByRole('button', { name: '+ Add card' }))
    let dialog = screen.getByRole('dialog', { name: 'New card in Backlog' })
    await user.type(within(dialog).getByLabelText('New card title'), 'Throwaway')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(within(backlog).queryByText('Throwaway')).not.toBeInTheDocument()

    await user.click(within(backlog).getByRole('button', { name: '+ Add card' }))
    dialog = screen.getByRole('dialog', { name: 'New card in Backlog' })
    await user.type(within(dialog).getByLabelText('New card title'), 'Quarter close')
    await user.type(within(dialog).getByLabelText('New label name'), 'R4C{Enter}')
    await user.click(within(dialog).getByRole('button', { name: 'Add card' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('R4C cards need a start date and an end date.')
    expect(within(backlog).queryByText('Quarter close')).not.toBeInTheDocument()

    fireEvent.change(within(dialog).getByLabelText(/Start date/), { target: { value: '2026-11-02' } })
    fireEvent.change(within(dialog).getByLabelText(/End date/), { target: { value: '2026-11-20' } })
    await user.click(within(dialog).getByRole('button', { name: 'Add card' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(within(backlog).getByText('Quarter close')).toBeInTheDocument()
  })

  it('adds an interface card with its spec from the popup', async () => {
    const user = userEvent.setup()
    renderApp()
    const backlog = screen.getByRole('region', { name: 'Column: Backlog' })
    await user.click(within(backlog).getByRole('button', { name: '+ Add card' }))
    const dialog = screen.getByRole('dialog', { name: 'New card in Backlog' })
    await user.type(within(dialog).getByLabelText('New card title'), 'Orders to CRM')
    await user.click(within(dialog).getByLabelText('Interface to build (SAP CPI iFlow)'))
    await user.type(within(dialog).getByLabelText('Sender system'), 'S/4HANA')
    await user.selectOptions(within(dialog).getByLabelText('Receiver adapter'), 'soap')
    await user.click(within(dialog).getByRole('button', { name: 'Add card' }))

    await user.click(within(backlog).getByText('Orders to CRM'))
    const editor = screen.getByRole('dialog', { name: 'Edit card: Orders to CRM' })
    expect(within(editor).getByLabelText('Sender system')).toHaveValue('S/4HANA')
    expect(within(editor).getByLabelText('Receiver adapter')).toHaveValue('soap')
  })

  it('shows only the last 5 cards in a done column, with a toggle for older ones', async () => {
    const user = userEvent.setup()
    renderApp()
    const done = screen.getByRole('region', { name: 'Column: Done' })
    for (let i = 1; i <= 5; i++) {
      await user.click(within(done).getByRole('button', { name: '+ Add card' }))
      await user.type(screen.getByLabelText('New card title'), `Finished ${i}{Enter}`)
    }
    // The sample card plus five new ones: the oldest folds away.
    expect(within(done).queryByText('Set up the board')).not.toBeInTheDocument()
    expect(within(done).getByText('Finished 1')).toBeInTheDocument()
    expect(within(done).getByText('Finished 5')).toBeInTheDocument()
    expect(within(done).getByText('6')).toBeInTheDocument()

    await user.click(within(done).getByRole('button', { name: 'Show 1 older card' }))
    expect(within(done).getByText('Set up the board')).toBeInTheDocument()
    await user.click(within(done).getByRole('button', { name: 'Hide older cards' }))
    expect(within(done).queryByText('Set up the board')).not.toBeInTheDocument()

    // Searching still finds hidden cards.
    await user.type(screen.getByLabelText('Search cards'), 'set up')
    expect(within(done).getByText('Set up the board')).toBeInTheDocument()
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

  it('asks for a start and end date on Project cards and shows the range on the card', async () => {
    const user = userEvent.setup()
    renderApp()
    await user.click(screen.getByText('Fix login timeout'))
    let dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText('Due date')).toBeInTheDocument()
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()

    await user.type(within(dialog).getByLabelText('New label name'), 'Project{Enter}')
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Project cards need a start date.')
    expect(within(dialog).getByLabelText('End date (required)')).toBeRequired()
    const start = within(dialog).getByLabelText('Start date (required)')
    expect(start).toBeInvalid()

    // Turning the label back on takes you to the start date.
    const chip = within(dialog).getByRole('button', { name: 'Project', pressed: true })
    await user.click(chip)
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Project', pressed: false }))
    expect(start).toHaveFocus()

    await user.keyboard('{Escape}')
    const card = screen.getByText('Fix login timeout').closest('.card') as HTMLElement
    expect(within(card).getByText(/Needs dates/)).toBeInTheDocument()

    await user.click(screen.getByText('Fix login timeout'))
    dialog = screen.getByRole('dialog')
    const end = within(dialog).getByLabelText('End date (required)') as HTMLInputElement
    fireEvent.change(within(dialog).getByLabelText('Start date (required)'), { target: { value: '2030-01-01' } })
    expect(within(dialog).getByRole('alert')).toHaveTextContent('The start date is after the end date.')
    fireEvent.change(end, { target: { value: '2030-02-15' } })
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(within(card).queryByText(/Needs dates/)).not.toBeInTheDocument()
    expect(within(card).getByTitle('2030-01-01 to 2030-02-15')).toHaveTextContent('Jan 1, 2030 – Feb 15, 2030')
  })

  it('starts a card when it moves to In progress and works out the due date from the estimate', async () => {
    const user = userEvent.setup()
    renderApp()
    await user.click(screen.getByText('Explore keyboard shortcuts'))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Starts when the card moves to In progress.')).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Estimate (MD)'), '3{Enter}')
    await user.selectOptions(within(dialog).getByLabelText('Column'), 'In progress')

    const start = within(dialog).getByLabelText('Start date') as HTMLInputElement
    expect(start.value).toBe(todayISO())
    const due = within(dialog).getByLabelText('Due date') as HTMLInputElement
    expect(due.value).toBe(dueFromEstimate(todayISO(), 3))
    expect(within(dialog).getByText(/worked out from the start date and estimate/)).toBeInTheDocument()

    // Changing the estimate moves the due date.
    const estimate = within(dialog).getByLabelText('Estimate (MD)')
    await user.clear(estimate)
    await user.type(estimate, '1{Enter}')
    expect(due.value).toBe(dueFromEstimate(todayISO(), 1))

    await user.keyboard('{Escape}')
    const card = screen.getByText('Explore keyboard shortcuts').closest('.card') as HTMLElement
    expect(within(card).getByTitle('Estimate: 1 man-days')).toHaveTextContent('⏱ 1 MD')
    expect(within(screen.getByRole('region', { name: 'Column: In progress' })).getByText('Explore keyboard shortcuts')).toBeInTheDocument()
  })

  it('tracks a card’s progress and logs progress updates', async () => {
    const user = userEvent.setup()
    renderApp()
    await user.click(screen.getByText('Plan next sprint'))
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Track progress' }))
    const percent = within(dialog).getByLabelText('Progress percent (number)')
    await user.clear(percent)
    await user.type(percent, '60')
    await user.type(within(dialog).getByLabelText('Progress update'), 'Backlog reviewed{Enter}')
    const log = within(dialog).getByRole('list', { name: 'Progress updates' })
    expect(within(log).getByText('Backlog reviewed')).toBeInTheDocument()
    expect(within(log).getByText(/60%/)).toBeInTheDocument()
    await user.keyboard('{Escape}')

    const card = screen.getByRole('button', { name: 'Card: Plan next sprint' })
    expect(within(card).getByRole('progressbar', { name: 'Progress' })).toHaveAttribute('aria-valuenow', '60')
    expect(within(card).getByText('60%')).toBeInTheDocument()
  })

  it('shows the latest progress update on a card and toggles the recent ones', async () => {
    const user = userEvent.setup()
    renderApp()
    const card = screen.getByRole('button', { name: 'Card: Drag me to another column' })
    const latest = within(card).getByRole('list', { name: 'Latest progress' })
    expect(within(latest).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Reordered the columns too'])

    await user.click(within(card).getByRole('button', { name: 'Show progress updates' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(within(latest).getAllByRole('listitem')).toHaveLength(2)
    expect(within(latest).getByText('Tried dragging between columns')).toBeInTheDocument()

    within(card).getByRole('button', { name: 'Hide progress updates' }).focus()
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(within(latest).getAllByRole('listitem')).toHaveLength(1)
  })

  it('opens a card’s checklist on the board and ticks items there', async () => {
    const user = userEvent.setup()
    renderApp()
    const card = screen.getByRole('button', { name: 'Card: Plan next sprint' })
    expect(within(card).queryByRole('list', { name: 'Checklist' })).not.toBeInTheDocument()

    await user.click(within(card).getByRole('button', { name: 'Show checklist, 0 of 3 done' }))
    const list = within(card).getByRole('list', { name: 'Checklist' })
    await user.click(within(list).getByRole('checkbox', { name: 'Review backlog' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(within(list).getByRole('checkbox', { name: 'Review backlog' })).toBeChecked()

    // Space ticks the focused item instead of starting a drag.
    within(list).getByRole('checkbox', { name: 'Estimate stories' }).focus()
    await user.keyboard(' ')
    expect(within(list).getByRole('checkbox', { name: 'Estimate stories' })).toBeChecked()

    await user.click(within(card).getByRole('button', { name: 'Hide checklist, 2 of 3 done' }))
    expect(within(card).queryByRole('list', { name: 'Checklist' })).not.toBeInTheDocument()

    // The card dialog shows the same ticks.
    await user.click(screen.getByText('Plan next sprint'))
    expect(within(screen.getByRole('dialog')).getByText('Checklist (2/3)')).toBeInTheDocument()
  })

  it('shows who is assigned on the card and assigns people in the card dialog', async () => {
    const user = userEvent.setup()
    renderApp()
    const card = screen.getByRole('button', { name: 'Card: Plan next sprint' })
    expect(within(card).getByRole('img', { name: 'Assigned to Alex, Sam' })).toBeInTheDocument()

    await user.click(screen.getByText('Explore keyboard shortcuts'))
    const dialog = screen.getByRole('dialog')
    // Alex already has 3 open cards, which is their capacity.
    expect(within(dialog).getByRole('button', { name: /Alex/ })).toHaveTextContent('full')
    await user.click(within(dialog).getByRole('button', { name: /Sam/ }))
    expect(within(dialog).getByRole('button', { name: /Sam/ })).toHaveAttribute('aria-pressed', 'true')
    await user.type(within(dialog).getByLabelText('New team member name'), 'Kim{Enter}')
    expect(within(dialog).getByRole('button', { name: /Kim/ })).toHaveAttribute('aria-pressed', 'true')
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))

    const explored = screen.getByRole('button', { name: 'Card: Explore keyboard shortcuts' })
    expect(within(explored).getByRole('img', { name: 'Assigned to Sam, Kim' })).toBeInTheDocument()
  })

  it('filters the board by assignee', async () => {
    const user = userEvent.setup()
    renderApp()
    await user.click(screen.getByRole('button', { name: /^Filter/ }))
    const filters = screen.getByRole('group', { name: 'Filters' })
    await user.click(within(filters).getByRole('button', { name: /Sam/ }))
    expect(screen.getByText('Plan next sprint')).toBeInTheDocument()
    expect(screen.queryByText('Fix login timeout')).not.toBeInTheDocument()
    await user.click(within(filters).getByRole('button', { name: /Sam/ }))
    await user.click(within(filters).getByRole('button', { name: 'Unassigned' }))
    expect(screen.getByText('Explore keyboard shortcuts')).toBeInTheDocument()
    expect(screen.queryByText('Plan next sprint')).not.toBeInTheDocument()
  })

  it('shows each person’s workload and edits the team', async () => {
    const user = userEvent.setup()
    renderApp()
    await user.click(screen.getByRole('button', { name: 'Team' }))
    const dialog = screen.getByRole('dialog', { name: 'Team and workload' })
    const alex = within(dialog).getByRole('listitem', { name: 'Workload: Alex' })
    expect(alex).toHaveTextContent('3 of 3 open')
    expect(alex).toHaveTextContent('At capacity')
    expect(alex).toHaveTextContent('1 overdue')
    await user.click(within(alex).getByRole('button', { name: 'Show 3 open cards' }))
    expect(within(alex).getByRole('button', { name: 'Fix login timeout' })).toBeInTheDocument()
    expect(within(dialog).getByRole('listitem', { name: 'Workload: Unassigned' })).toHaveTextContent('2 open cards')

    // Lowering Alex's capacity puts them over it.
    const capacity = within(dialog).getByLabelText('Capacity of Alex')
    await user.clear(capacity)
    await user.type(capacity, '2')
    expect(alex).toHaveTextContent('Over capacity')

    await user.type(within(dialog).getByLabelText('New team member name'), 'Kim')
    await user.type(within(dialog).getByLabelText('New team member capacity'), '4')
    await user.click(within(dialog).getByRole('button', { name: 'Add to team' }))
    expect(within(dialog).getByRole('listitem', { name: 'Workload: Kim' })).toHaveTextContent('0 of 4 open')

    // Opening a card from the workload list closes the dialog and shows the card.
    await user.click(within(alex).getByRole('button', { name: 'Fix login timeout' }))
    expect(screen.getByRole('dialog', { name: 'Edit card: Fix login timeout' })).toBeInTheDocument()
  })

  it('shows who is busy when on a timeline and a month calendar', async () => {
    const user = userEvent.setup()
    renderApp()
    await user.click(screen.getByRole('button', { name: 'Team' }))
    const dialog = screen.getByRole('dialog', { name: 'Team and workload' })
    await user.click(within(dialog).getByRole('button', { name: 'Timeline' }))

    const alex = within(dialog).getByRole('row', { name: 'Timeline: Alex' })
    expect(within(alex).getByRole('button', { name: /^Plan next sprint/ })).toBeInTheDocument()
    expect(within(alex).getByRole('button', { name: /^Fix login timeout/ })).toBeInTheDocument()
    const sam = within(dialog).getByRole('row', { name: 'Timeline: Sam' })
    expect(within(sam).getByRole('button', { name: /^Plan next sprint/ })).toBeInTheDocument()
    expect(within(sam).queryByRole('button', { name: /^Fix login timeout/ })).not.toBeInTheDocument()

    // Showing one person hides the others.
    await user.click(within(dialog).getByRole('button', { name: 'Sam' }))
    expect(within(dialog).queryByRole('row', { name: 'Timeline: Alex' })).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Everyone' }))

    // The month view lists a day's cards and who has them.
    await user.click(within(dialog).getByRole('button', { name: 'Month' }))
    const month = within(dialog).getByRole('region', { name: 'Team month' })
    const today = new Date()
    const dayName = today.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
    await user.click(within(month).getByRole('button', { name: new RegExp(`^${dayName}:`) }))
    const detail = within(dialog).getByRole('region', { name: `Cards on ${dayName}` })
    expect(within(detail).getByRole('img', { name: 'Assigned to Alex, Sam' })).toBeInTheDocument()
    await user.click(within(detail).getByRole('button', { name: 'Plan next sprint' }))
    expect(screen.getByRole('dialog', { name: 'Edit card: Plan next sprint' })).toBeInTheDocument()
  })

  it('filters the board to one person from the workload view', async () => {
    const user = userEvent.setup()
    renderApp()
    await user.click(screen.getByRole('button', { name: 'Team' }))
    const sam = within(screen.getByRole('dialog')).getByRole('listitem', { name: 'Workload: Sam' })
    await user.click(within(sam).getByRole('button', { name: 'Filter board' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('Plan next sprint')).toBeInTheDocument()
    expect(screen.queryByText('Fix login timeout')).not.toBeInTheDocument()
  })

  it('keeps a list of interfaces per member, each with its own spec', async () => {
    const user = userEvent.setup()
    renderApp()
    await user.click(screen.getByRole('button', { name: '+ New board' }))
    await user.type(screen.getByPlaceholderText('e.g. Home renovation'), 'Checkout')
    await user.click(screen.getByRole('radio', { name: /Project/ }))
    await user.click(screen.getByRole('button', { name: 'Create board' }))
    for (const title of ['Spec', 'To implement', 'In progress', 'Review', 'Done']) {
      expect(screen.getByRole('region', { name: `Column: ${title}` })).toBeInTheDocument()
    }
    await user.click(screen.getByRole('button', { name: 'Team' }))
    await user.type(screen.getByLabelText('New team member name'), 'Kim')
    await user.click(screen.getByRole('button', { name: 'Add to team' }))
    await user.click(screen.getByRole('button', { name: 'Close' }))

    await user.click(screen.getByRole('button', { name: 'Interfaces' }))
    let dialog = screen.getByRole('dialog', { name: 'Interfaces' })
    expect(dialog).toHaveTextContent('No interfaces yet')
    await user.type(within(dialog).getByLabelText('Interface name'), 'Create order')
    await user.selectOptions(within(dialog).getByLabelText('Built by'), 'Kim')
    await user.click(within(dialog).getByRole('button', { name: 'Add interface' }))
    // The form keeps the person picked, for adding several in a row.
    await user.type(within(dialog).getByLabelText('Interface name'), 'Order placed')
    await user.selectOptions(within(dialog).getByLabelText('Sender adapter'), 'rfc')
    await user.selectOptions(within(dialog).getByLabelText('Receiver adapter'), 'soap')
    await user.selectOptions(within(dialog).getByLabelText('Built by'), 'Nobody yet')
    await user.click(within(dialog).getByRole('button', { name: 'Add interface' }))
    const kim = within(dialog).getByRole('region', { name: 'Interfaces: Kim' })
    expect(kim).toHaveTextContent('1 interface · 0 specs agreed · 0 done')
    expect(within(dialog).getByRole('region', { name: 'Interfaces: Nobody yet' })).toHaveTextContent('Order placed')

    // Write the spec in the card dialog.
    await user.click(within(kim).getByRole('button', { name: 'Create order' }))
    const card = screen.getByRole('dialog', { name: 'Edit card: Create order' })
    const spec = within(card).getByRole('region', { name: 'Interface spec' })
    await user.type(within(spec).getByLabelText('Sender system'), 'S/4HANA')
    await user.type(within(spec).getByLabelText('Receiver system'), 'Salesforce')
    await user.selectOptions(within(spec).getByLabelText('Receiver adapter'), 'odata')
    await user.selectOptions(within(spec).getByLabelText('Message mode'), 'sync')
    await user.type(within(spec).getByLabelText('iFlow / endpoint'), 'ORDERS05')
    expect(within(spec).queryByLabelText('Source message')).not.toBeInTheDocument()
    expect(within(spec).queryByLabelText('Target message and mapping')).not.toBeInTheDocument()
    await user.selectOptions(within(spec).getByLabelText('Spec status'), 'agreed')
    expect(within(spec).getByRole('status')).toHaveTextContent('Agreed, but still empty: Notes')
    await user.keyboard('{Escape}')

    const column = screen.getByRole('region', { name: 'Column: Spec' })
    const face = within(column).getByRole('button', { name: 'Card: Create order' })
    expect(face).toHaveTextContent('S/4HANA → Salesforce')
    expect(face).toHaveTextContent('IDoc → OData · Agreed')
    expect(within(column).getByRole('button', { name: 'Card: Order placed' })).toHaveTextContent('RFC → SOAP · Draft')

    await user.keyboard('i')
    dialog = screen.getByRole('dialog', { name: 'Interfaces' })
    expect(within(dialog).getByRole('region', { name: 'Interfaces: Kim' })).toHaveTextContent(
      '1 interface · 1 spec agreed · 0 done',
    )
    expect(dialog).toHaveTextContent('S/4HANA (IDoc) → Salesforce (OData) · ORDERS05')
  })

  it('adds a spec to any card and removes it again', async () => {
    const user = userEvent.setup()
    renderApp()
    await user.click(screen.getByText('Fix login timeout'))
    const card = screen.getByRole('dialog', { name: 'Edit card: Fix login timeout' })
    await user.click(within(card).getByRole('button', { name: '+ Add interface spec' }))
    await user.selectOptions(within(card).getByLabelText('Sender adapter'), 'sftp')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Card: Fix login timeout' })).toHaveTextContent('SFTP → HTTP · Draft')

    await user.click(screen.getByText('Fix login timeout'))
    const again = screen.getByRole('dialog', { name: 'Edit card: Fix login timeout' })
    await user.click(within(again).getByRole('button', { name: 'Remove spec' }))
    expect(within(again).getByRole('button', { name: '+ Add interface spec' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Card: Fix login timeout' })).not.toHaveTextContent('Draft')
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

  it('upgrades boards saved before progress existed', () => {
    const saved = createSampleState()
    const cards = Object.fromEntries(
      Object.entries(saved.cards).map(([id, { progress: _p, progressLog: _l, ...card }]) => [id, card]),
    )
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, version: 1, cards }))
    const state = loadState()
    expect(state.version).toBe(7)
    expect(Object.keys(state.cards)).toEqual(Object.keys(saved.cards))
    for (const card of Object.values(state.cards)) expect(card.progressLog).toEqual([])
  })

  it('upgrades boards saved before teams existed', () => {
    const saved = createSampleState()
    const cards = Object.fromEntries(
      Object.entries(saved.cards).map(([id, { assigneeIds: _a, ...card }]) => [id, card]),
    )
    const boards = Object.fromEntries(Object.entries(saved.boards).map(([id, { team: _t, ...board }]) => [id, board]))
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, version: 2, boards, cards }))
    const state = loadState()
    expect(state.version).toBe(7)
    for (const board of Object.values(state.boards)) expect(board.team).toEqual([])
    for (const card of Object.values(state.cards)) expect(card.assigneeIds).toEqual([])
  })

  it('upgrades cards saved before estimates existed', () => {
    const saved = createSampleState()
    const cards = Object.fromEntries(
      Object.entries(saved.cards).map(([id, { estimateDays: _e, ...card }]) => [id, card]),
    )
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, version: 4, cards }))
    const state = loadState()
    expect(state.version).toBe(7)
    for (const card of Object.values(state.cards)) expect(card.estimateDays).toBeNull()
  })

  it('upgrades cards saved before interface specs existed', () => {
    const saved = createSampleState()
    const cards = Object.fromEntries(Object.entries(saved.cards).map(([id, { spec: _s, ...card }]) => [id, card]))
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, version: 5, cards }))
    const state = loadState()
    expect(state.version).toBe(7)
    for (const card of Object.values(state.cards)) expect(card.spec).toBeNull()
  })

  it('moves text from the old source and target message fields into the notes', () => {
    const saved = createSampleState()
    const [id, card] = Object.entries(saved.cards)[0]
    const oldSpec = { ...emptySpec(), notes: 'OAuth', input: 'IDoc ORDERS05', output: 'Map to SalesOrder' }
    const cards = { ...saved.cards, [id]: { ...card, spec: oldSpec } }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, version: 6, cards }))
    const state = loadState()
    expect(state.version).toBe(7)
    expect(state.cards[id].spec).not.toHaveProperty('input')
    expect(state.cards[id].spec?.notes).toBe(
      'OAuth\n\nSource message:\nIDoc ORDERS05\n\nTarget message and mapping:\nMap to SalesOrder',
    )
  })

  it('upgrades cards saved before start dates existed', () => {
    const saved = createSampleState()
    const cards = Object.fromEntries(Object.entries(saved.cards).map(([id, { startDate: _s, ...card }]) => [id, card]))
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, version: 3, cards }))
    const state = loadState()
    expect(state.version).toBe(7)
    for (const card of Object.values(state.cards)) expect(card.startDate).toBeNull()
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

  it('stays on this device, with no sign-in, when the server does not answer', async () => {
    const api = new MemoryServer().client(null)
    api.getUser = () => Promise.reject(new Error('The app server is not running.'))
    renderWithCloud(api)
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument()
    expect(screen.getByRole('main', { name: 'Board: Work' })).toBeInTheDocument()
  })

  it('waits for a server that is still starting', async () => {
    const api = new MemoryServer().client(null)
    const getUser = api.getUser.bind(api)
    let calls = 0
    api.getUser = () => (++calls === 1 ? Promise.reject(new UnreachableError('starting')) : getUser())
    renderWithCloud(api)
    expect(screen.getByRole('status')).toHaveTextContent('Connecting to the server')
    expect(await screen.findByRole('main', { name: 'Sign in' }, { timeout: 3000 })).toBeInTheDocument()
    expect(calls).toBeGreaterThan(1)
  })

  it('asks for sign-in before showing any board when the server answers', async () => {
    renderWithCloud(new MemoryServer().client(null))
    expect(await screen.findByRole('main', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('main', { name: 'Board: Work' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '+ New board' })).not.toBeInTheDocument()
  })

  it('creates an account, signs out and signs back in', async () => {
    const user = userEvent.setup()
    renderWithCloud(new MemoryServer().client(null))
    await user.click(await screen.findByRole('button', { name: 'Create an account' }))
    await user.type(screen.getByLabelText('Email'), 'ana@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct horse')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByRole('main', { name: 'Board: Work' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Account: ana@example.com' }))
    await user.click(screen.getByRole('menuitem', { name: 'Sign out ana@example.com' }))

    expect(await screen.findByRole('main', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('main', { name: 'Board: Work' })).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Email'), 'ana@example.com')
    await user.type(screen.getByLabelText('Password'), 'wrong password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong email or password')
    await user.clear(screen.getByLabelText('Password'))
    await user.type(screen.getByLabelText('Password'), 'correct horse')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('button', { name: 'Account: ana@example.com' })).toBeInTheDocument()
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

  it('attaches Word and Excel spec files to a card, downloads and removes them', async () => {
    const user = userEvent.setup()
    const { server, ana, boardId } = await serverWithTrip()
    renderWithCloud(server.client(ana))
    const trip = await screen.findByRole('option', { name: 'Trip' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Current board' }), trip)

    await user.click(await screen.findByText('Pack bags'))
    let card = screen.getByRole('dialog', { name: 'Edit card: Pack bags' })
    const word = new File(['spec text'], 'Packing spec.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    const sheet = new File(['a,b'], 'mapping.xlsx')
    await user.upload(within(card).getByLabelText('Choose files to attach'), [word, sheet])
    const list = await within(card).findByRole('list', { name: 'Attached files' })
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2))
    expect(within(list).getByRole('button', { name: 'View Packing spec.docx' })).toBeInTheDocument()
    const link = within(list).getByRole('link', { name: 'Download Packing spec.docx' })
    expect(link).toHaveAttribute('download', 'Packing spec.docx')
    expect(link.getAttribute('href')).toMatch(/^data:application\/vnd\.openxml/)
    expect(server.attachments.map((a) => [a.boardId, a.name, atob(a.data)])).toEqual([
      [boardId, 'Packing spec.docx', 'spec text'],
      [boardId, 'mapping.xlsx', 'a,b'],
    ])

    // Files that can't be attached are refused with a message.
    fireEvent.change(within(card).getByLabelText('Choose files to attach'), {
      target: { files: [new File(['x'], 'tool.exe')] },
    })
    expect(await within(card).findByRole('alert')).toHaveTextContent('only Word, Excel')

    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Card: Pack bags' })).toHaveTextContent('📎 2')

    await user.click(screen.getByText('Pack bags'))
    card = screen.getByRole('dialog', { name: 'Edit card: Pack bags' })
    window.confirm = () => true
    await user.click(within(card).getByRole('button', { name: 'Remove mapping.xlsx' }))
    await waitFor(() => expect(server.attachments.map((a) => a.name)).toEqual(['Packing spec.docx']))
    expect(await within(card).findByText('Files (1)')).toBeInTheDocument()
  })

  it('keeps technical and mapping spec files apart and shows them in the app', async () => {
    const user = userEvent.setup()
    const { server, ana } = await serverWithTrip()
    renderWithCloud(server.client(ana))
    const trip = await screen.findByRole('option', { name: 'Trip' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Current board' }), trip)

    await user.click(await screen.findByText('Pack bags'))
    const card = screen.getByRole('dialog', { name: 'Edit card: Pack bags' })
    await user.click(within(card).getByRole('button', { name: '+ Add interface spec' }))
    const technical = within(card).getByRole('region', { name: 'Technical spec' })
    const mapping = within(card).getByRole('region', { name: 'Mapping spec' })
    expect(within(card).getByRole('region', { name: 'Other files' })).toBeInTheDocument()

    await user.upload(within(technical).getByLabelText('Choose technical spec files'), [
      new File(['Use OAuth.\nRetry 3 times.'], 'design.txt', { type: 'text/plain' }),
    ])
    await user.upload(within(mapping).getByLabelText('Choose mapping spec files'), [
      new File(['Source,Target\nMATNR,"sku, code"'], 'fields.csv', { type: 'text/csv' }),
    ])
    await within(technical).findByRole('button', { name: 'View design.txt' })
    await within(mapping).findByRole('button', { name: 'View fields.csv' })
    expect(server.attachments.map((a) => [a.name, a.category])).toEqual([
      ['design.txt', 'technical'],
      ['fields.csv', 'mapping'],
    ])

    // A text file opens as text, over the card, and Escape closes only the preview.
    await user.click(within(technical).getByRole('button', { name: 'View design.txt' }))
    const preview = await screen.findByRole('dialog', { name: 'View design.txt' })
    expect(await within(preview).findByText(/Use OAuth\.\s+Retry 3 times\./)).toBeInTheDocument()
    expect(within(preview).getByRole('link', { name: '⬇ Download' })).toHaveAttribute('download', 'design.txt')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'View design.txt' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Edit card: Pack bags' })).toBeInTheDocument()

    // A CSV file opens as a table.
    await user.click(within(mapping).getByRole('button', { name: 'View fields.csv' }))
    const table = await screen.findByRole('table', { name: 'fields.csv' })
    expect(within(table).getAllByRole('row')).toHaveLength(2)
    expect(within(table).getByText('sku, code')).toBeInTheDocument()
    await user.click(within(screen.getByRole('dialog', { name: 'View fields.csv' })).getByRole('button', { name: 'Close' }))

    // A file can move to another section.
    await user.selectOptions(within(technical).getByLabelText('Section for design.txt'), 'mapping')
    await waitFor(() => expect(within(mapping).getAllByRole('listitem')).toHaveLength(2))
    expect(server.attachments.map((a) => a.category)).toEqual(['mapping', 'mapping'])
    expect(within(technical).queryByRole('listitem')).not.toBeInTheDocument()
  })

  it('shows files read-only to viewers', async () => {
    const { server, ana, boardId } = await serverWithTrip()
    const anaApi = server.client(ana)
    await anaApi.addAttachment('c1', { name: 'spec.pdf', data: btoa('pdf') })
    const token = await anaApi.createInviteLink(boardId, 'viewer')
    window.history.replaceState(null, '', `/?join=${token}`)
    const user = userEvent.setup()
    renderWithCloud(server.client(server.addUser('cat@example.com')))
    await user.click(await screen.findByText('Pack bags'))
    const card = screen.getByRole('dialog', { name: 'Card: Pack bags' })
    expect(await within(card).findByRole('button', { name: 'View spec.pdf' })).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: 'Download spec.pdf' })).toBeInTheDocument()
    expect(within(card).queryByLabelText('Choose files to attach')).not.toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: 'Remove spec.pdf' })).not.toBeInTheDocument()
  })

  it('lets the board owner approve or reject assignments asked for through MCP', async () => {
    const user = userEvent.setup()
    const { server, ana, boardId } = await serverWithTrip()
    const anaApi = server.client(ana)
    const doc = (await anaApi.fetchBoard(boardId))!
    await anaApi.applyOps(boardId, {
      board: { title: 'Trip', labels: doc.board.labels, team: [{ id: 'kim', name: 'Kim', color: '#0090ff', capacity: 0 }] },
      upsertColumns: [],
      deleteColumnIds: [],
      upsertCards: [],
      deleteCardIds: [],
    })
    renderWithCloud(anaApi)
    const trip = await screen.findByRole('option', { name: 'Trip' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Current board' }), trip)

    act(() => server.requestAssignment(boardId, 'c1', ['Kim', 'Lee'], 'ana@example.com'))
    expect(await screen.findByText('1 assignment from MCP needs your approval.')).toBeInTheDocument()
    expect(screen.getByText('⏳ Assignment pending')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Review' }))
    let dialog = screen.getByRole('dialog', { name: 'Assignments to approve' })
    expect(within(dialog).getByText('Kim, Lee (new to the team)')).toBeInTheDocument()
    expect(within(dialog).getByText(/Now: nobody · asked by ana@example.com/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Approve assignment for Pack bags' }))
    expect(await within(dialog).findByText('Nothing is waiting.')).toBeInTheDocument()
    expect(server.cards.get('c1')!.assignee_ids).toHaveLength(2)
    expect(server.boards.get(boardId)!.team!.map((m) => m.name)).toEqual(['Kim', 'Lee'])
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByText(/needs your approval/)).not.toBeInTheDocument())
    expect(screen.queryByText('⏳ Assignment pending')).not.toBeInTheDocument()

    // A second request, turned down from the card itself.
    act(() => server.requestAssignment(boardId, 'c1', [], 'ana@example.com'))
    await screen.findByText('⏳ Assignment pending')
    await user.click(screen.getByRole('button', { name: 'Card: Pack bags' }))
    dialog = screen.getByRole('dialog', { name: 'Edit card: Pack bags' })
    expect(within(dialog).getByText(/Waiting for approval: assign to/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Reject assignment for Pack bags' }))
    await waitFor(() => expect(within(dialog).queryByText(/Waiting for approval/)).not.toBeInTheDocument())
    expect(server.assignmentRequests).toEqual([])
    expect(server.cards.get('c1')!.assignee_ids).toHaveLength(2)
  })

  it('shows other members that an assignment waits for the owner, without approving', async () => {
    const user = userEvent.setup()
    const { server, ana, boardId } = await serverWithTrip()
    await server.client(ana).inviteByEmail(boardId, 'ben@example.com', 'editor')
    const benApi = server.client(server.addUser('ben@example.com'))
    await benApi.acceptInvite((await benApi.listReceivedInvites())[0].id)
    server.requestAssignment(boardId, 'c1', ['Kim'], 'ben@example.com')
    renderWithCloud(benApi)
    const trip = await screen.findByRole('option', { name: 'Trip · can edit' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Current board' }), trip)

    expect(await screen.findByText('1 assignment is waiting for the board owner to approve.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'View' }))
    const dialog = screen.getByRole('dialog', { name: 'Assignments to approve' })
    expect(within(dialog).getByText('Kim (new to the team)')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument()
  })

  it('creates an API key for n8n, shows it once, and revokes it', async () => {
    const user = userEvent.setup()
    const server = new MemoryServer()
    renderWithCloud(server.client(server.addUser('ana@example.com')))
    await user.click(await screen.findByRole('button', { name: 'Account: ana@example.com' }))
    await user.click(screen.getByRole('menuitem', { name: 'API keys…' }))
    const dialog = screen.getByRole('dialog', { name: 'API keys' })
    expect(within(dialog).getByText('No API keys yet.')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('REST API')).toHaveValue(`${window.location.origin}/api/v1`)
    expect(within(dialog).getByLabelText('MCP server')).toHaveValue(`${window.location.origin}/api/mcp`)

    await user.type(within(dialog).getByLabelText('Key name'), 'n8n')
    await user.click(within(dialog).getByRole('button', { name: 'Create API key' }))
    expect(await within(dialog).findByLabelText('Your new API key')).toHaveValue(server.apiKeys[0].key)
    expect(within(dialog).getByText(/won’t be shown again/)).toBeInTheDocument()
    expect(await within(dialog).findByText('n8n')).toBeInTheDocument()
    expect(within(dialog).getByText(/never used/)).toBeInTheDocument()

    const confirm = window.confirm
    window.confirm = () => true
    try {
      await user.click(within(dialog).getByRole('button', { name: 'Revoke n8n' }))
    } finally {
      window.confirm = confirm
    }
    expect(await within(dialog).findByText('No API keys yet.')).toBeInTheDocument()
    expect(server.apiKeys).toEqual([])
  })

  it('lists apps connected with sign-in and disconnects them', async () => {
    const user = userEvent.setup()
    const server = new MemoryServer()
    const ana = server.addUser('ana@example.com')
    server.connectedApps.push({
      id: 'claude',
      name: 'Claude',
      connectedAt: new Date().toISOString(),
      lastUsedAt: null,
      userId: ana.id,
    })
    renderWithCloud(server.client(ana))
    await user.click(await screen.findByRole('button', { name: 'Account: ana@example.com' }))
    await user.click(screen.getByRole('menuitem', { name: 'API keys…' }))
    const dialog = screen.getByRole('dialog', { name: 'API keys' })
    expect(await within(dialog).findByText('Claude')).toBeInTheDocument()

    const confirm = window.confirm
    window.confirm = () => true
    try {
      await user.click(within(dialog).getByRole('button', { name: 'Disconnect Claude' }))
    } finally {
      window.confirm = confirm
    }
    expect(await within(dialog).findByText(/No apps connected/)).toBeInTheDocument()
    expect(server.connectedApps).toEqual([])
  })
  it('adds, finds, edits and deletes a contact', async () => {
    const user = userEvent.setup()
    const server = new MemoryServer()
    renderWithCloud(server.client(server.addUser('ana@example.com')))
    await user.click(await screen.findByRole('button', { name: 'Account: ana@example.com' }))
    await user.click(screen.getByRole('menuitem', { name: 'Contacts…' }))
    let dialog = screen.getByRole('dialog', { name: 'Contacts' })
    expect(await within(dialog).findByText(/No contacts yet/)).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: '+ Add contact' }))
    dialog = screen.getByRole('dialog', { name: 'New contact' })
    await user.type(within(dialog).getByLabelText('Name'), 'Alex Kim')
    await user.type(within(dialog).getByLabelText('Company'), 'Acme')
    await user.type(within(dialog).getByLabelText('Email'), 'alex@acme.test')
    await user.type(within(dialog).getByLabelText('Phone'), '+66 81 234 5678')
    await user.click(within(dialog).getByRole('button', { name: 'Add contact' }))

    dialog = await screen.findByRole('dialog', { name: 'Contacts' })
    expect(await within(dialog).findByText('Alex Kim')).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: 'alex@acme.test' })).toHaveAttribute('href', 'mailto:alex@acme.test')
    expect(within(dialog).getByRole('link', { name: '+66 81 234 5678' })).toHaveAttribute('href', 'tel:+66812345678')

    await user.type(within(dialog).getByLabelText('Search contacts'), 'nobody')
    expect(within(dialog).getByText(/No contacts match/)).toBeInTheDocument()
    await user.clear(within(dialog).getByLabelText('Search contacts'))

    await user.click(within(dialog).getByRole('button', { name: 'Edit Alex Kim' }))
    dialog = screen.getByRole('dialog', { name: 'Edit contact' })
    await user.type(within(dialog).getByLabelText('Job title'), 'Buyer')
    await user.click(within(dialog).getByRole('button', { name: 'Save contact' }))
    dialog = await screen.findByRole('dialog', { name: 'Contacts' })
    expect(await within(dialog).findByText('Buyer · Acme')).toBeInTheDocument()

    const confirm = window.confirm
    window.confirm = () => true
    try {
      await user.click(within(dialog).getByRole('button', { name: 'Delete Alex Kim' }))
    } finally {
      window.confirm = confirm
    }
    expect(await within(dialog).findByText(/No contacts yet/)).toBeInTheDocument()
    expect(server.contacts).toEqual([])
  })

  it('saves a credential with masked secrets, shows them on request, and edits it', async () => {
    const user = userEvent.setup()
    const server = new MemoryServer()
    renderWithCloud(server.client(server.addUser('ana@example.com')))
    await user.click(await screen.findByRole('button', { name: 'Account: ana@example.com' }))
    await user.click(screen.getByRole('menuitem', { name: 'Credentials…' }))
    let dialog = screen.getByRole('dialog', { name: 'Credentials' })
    expect(await within(dialog).findByText('No credentials yet.')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: '+ Add credential' }))
    dialog = screen.getByRole('dialog', { name: 'New credential' })
    await user.type(within(dialog).getByLabelText('Name'), 'Payments API')
    await user.selectOptions(within(dialog).getByLabelText('Type'), 'API key')
    await user.type(within(dialog).getByLabelText('Header name'), 'X-API-Key')
    expect(within(dialog).getByLabelText('API key')).toHaveAttribute('type', 'password')
    await user.type(within(dialog).getByLabelText('API key'), 'sk_live_123')
    await user.click(within(dialog).getByRole('button', { name: '+ Add field' }))
    await user.type(within(dialog).getByLabelText('Field name'), 'Webhook secret')
    await user.type(within(dialog).getAllByLabelText('Webhook secret').at(-1)!, 'whsec_9')
    await user.type(within(dialog).getByLabelText('Notes (encrypted)'), 'Rotate yearly')
    await user.click(within(dialog).getByRole('button', { name: 'Add credential' }))

    dialog = await screen.findByRole('dialog', { name: 'Credentials' })
    expect(await within(dialog).findByText('Payments API')).toBeInTheDocument()
    expect(within(dialog).getByText('X-API-Key')).toBeInTheDocument()
    expect(within(dialog).queryByText('sk_live_123')).not.toBeInTheDocument()
    expect(within(dialog).getAllByText('••••••••')).toHaveLength(2)
    expect(server.credentials[0].fields.find((f) => f.name === 'API key')!.value).toBeNull()
    expect(server.credentials[0].secrets).toEqual({
      fields: { 'API key': 'sk_live_123', 'Webhook secret': 'whsec_9' },
      notes: 'Rotate yearly',
    })

    await user.click(within(dialog).getByRole('button', { name: 'Show secrets of Payments API' }))
    expect(await within(dialog).findByText('sk_live_123')).toBeInTheDocument()
    expect(within(dialog).getByText('Rotate yearly')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Hide secrets of Payments API' }))
    expect(within(dialog).queryByText('sk_live_123')).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Edit Payments API' }))
    dialog = await screen.findByRole('dialog', { name: 'Edit credential' })
    expect(within(dialog).getByLabelText('API key')).toHaveValue('sk_live_123')
    await user.clear(within(dialog).getByLabelText('API key'))
    await user.type(within(dialog).getByLabelText('API key'), 'sk_live_456')
    await user.click(within(dialog).getByRole('button', { name: 'Save credential' }))
    await screen.findByRole('dialog', { name: 'Credentials' })
    expect(server.credentials[0].secrets.fields['API key']).toBe('sk_live_456')
    expect(server.credentials[0].secrets.fields['Webhook secret']).toBe('whsec_9')
  })
})
