// A Model Context Protocol server (Streamable HTTP transport, JSON responses,
// no sessions) at POST /api/mcp, so AI agents such as n8n's AI Agent with the
// MCP Client tool can manage boards. It authenticates like the REST API and
// calls the same operations (server/src/kanban.ts), with the same role checks.
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { User } from './access.ts'
import type { Db } from './db.ts'
import * as k from './kanban.ts'
import * as v from './validate.ts'
import { adapterTypes, messageModes, specStatuses } from '../../src/lib/interfaces.ts'

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

type Args = Record<string, unknown>
type JsonSchema = Record<string, unknown>

interface Tool {
  name: string
  title: string
  description: string
  inputSchema: JsonSchema
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean }
  run: (db: Db, user: User, args: Args) => Promise<unknown>
}

const text = (description: string) => ({ type: 'string', description })
const whole = (description: string) => ({ type: 'integer', minimum: 0, description })
const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const boardId = text('Board id, from list_boards.')
const cardId = text('Card id, from get_board or find_cards.')
const column = text('Column id or column title, e.g. "Done".')
const priority = { type: 'string', enum: ['none', 'low', 'medium', 'high', 'urgent'] }
const startDate = {
  type: ['string', 'null'],
  description:
    'Start date as YYYY-MM-DD; null or "" clears it. Cards labelled R4C or Project need both startDate and dueDate.',
}
const dueDate = {
  type: ['string', 'null'],
  description:
    'Due date (the end date) as YYYY-MM-DD; null or "" clears it. Cards labelled R4C or Project need both startDate and dueDate.',
}
const estimateDays = {
  type: ['number', 'null'],
  exclusiveMinimum: 0,
  maximum: 999,
  description:
    'Estimated effort in man-days (MD), e.g. 3 or 0.5; null clears it. For cards not labelled R4C or Project, the due date is worked out from the start date and this (weekdays only), and the start date is set to today when the card moves into an in-progress column.',
}
const labels = {
  type: 'array',
  items: { type: 'string' },
  description: 'Label names or ids. Names the board does not have yet become new labels. Replaces the card labels.',
}
const checklist = {
  type: 'array',
  items: {
    anyOf: [
      { type: 'string' },
      object({ text: { type: 'string' }, done: { type: 'boolean' } }, ['text']),
    ],
  },
  description: 'Checklist items, as text or {text, done}. Replaces the whole checklist.',
}
const progress = {
  type: ['integer', 'null'],
  minimum: 0,
  maximum: 100,
  description: 'How far along the task is, 0-100 percent; null stops tracking progress.',
}
const assignees = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Team member names or ids to assign the card to; replaces the assignees, [] unassigns everyone. Assignments made here need the board owner to approve them in the app: until then the card keeps its assignees and shows the request under pendingAssignment. Names the board team does not have yet join the team once approved.',
}
const adapter = (side: string) => ({
  type: 'string',
  enum: adapterTypes,
  description: `SAP Cloud Integration (CPI) adapter on the ${side} side, e.g. idoc, rfc, soap, xi, http, odata, sftp, as2, jdbc, processdirect.`,
})
const spec = {
  anyOf: [
    object({
      senderSystem: text('System that sends the message, e.g. "S/4HANA PRD".'),
      senderAdapter: adapter('sender'),
      receiverSystem: text('System that receives it, e.g. "Salesforce".'),
      receiverAdapter: adapter('receiver'),
      mode: { type: 'string', enum: messageModes, description: 'async (fire and forget) or sync (request and reply).' },
      endpoint: text('iFlow name or address, e.g. "/orders/create", an IDoc type or a folder.'),
      input: text('Source message: structure or sample, IDoc type, file layout (Markdown is fine).'),
      output: text('Target message and mapping rules, response or acknowledgement (Markdown is fine).'),
      notes: text('Anything else: auth, error handling, retries, volume, schedule.'),
      status: { type: 'string', enum: specStatuses, description: 'draft, review (out for review) or agreed.' },
    }),
    { type: 'null' },
  ],
  description:
    'Technical spec when the card is an SAP CPI integration someone builds. Only the fields given change; a card without a spec gets one (idoc to http, async, draft by default). null removes the spec.',
}
const member = text('Team member name or id, from get_board (team).')
const cardFields = {
  title: text('Card title.'),
  description: text('Notes (plain text).'),
  priority,
  startDate,
  dueDate,
  estimateDays,
  labels,
  checklist,
  progress,
  assignees,
  spec,
}

export const tools: Tool[] = [
  {
    name: 'list_boards',
    title: 'List boards',
    description: 'List the boards you can see, with your role on each (owner, editor or viewer) and card counts.',
    inputSchema: object({}),
    annotations: { readOnlyHint: true },
    run: (db, user) => k.listBoards(db, user),
  },
  {
    name: 'get_board',
    title: 'Get a board',
    description: 'Get a board with its labels, its team, its columns in order and every card in each column.',
    inputSchema: object({ boardId }, ['boardId']),
    annotations: { readOnlyHint: true },
    run: (db, user, a) => k.getBoard(db, user, v.ref(a.boardId, 'boardId')),
  },
  {
    name: 'create_board',
    title: 'Create a board',
    description: 'Create a board in your account. Columns default to To do, In progress and Done.',
    inputSchema: object(
      {
        title: text('Board title.'),
        columns: { type: 'array', items: { type: 'string' }, description: 'Column titles, left to right.' },
        labels: {
          type: 'array',
          items: object({ name: { type: 'string' }, color: text('Hex color like #0090ff (optional).') }, ['name']),
        },
      },
      ['title'],
    ),
    annotations: {},
    run: (db, user, a) => k.createBoard(db, user, v.newBoardInput(a)),
  },
  {
    name: 'rename_board',
    title: 'Rename a board',
    description: 'Change a board title. Needs editor or owner role.',
    inputSchema: object({ boardId, title: text('New title.') }, ['boardId', 'title']),
    annotations: { idempotentHint: true },
    run: (db, user, a) => k.updateBoard(db, user, v.ref(a.boardId, 'boardId'), v.boardPatchInput({ title: a.title })),
  },
  {
    name: 'add_column',
    title: 'Add a column',
    description: 'Add a column to a board, at the end unless a position (0 = first) is given.',
    inputSchema: object(
      { boardId, title: text('Column title.'), wipLimit: whole('Work-in-progress limit, 0 for none.'), position: whole('0 = first.') },
      ['boardId', 'title'],
    ),
    annotations: {},
    run: (db, user, a) => {
      const { boardId: id, ...rest } = a
      return k.createColumn(db, user, v.ref(id, 'boardId'), v.columnInput(rest, true))
    },
  },
  {
    name: 'update_column',
    title: 'Update a column',
    description: 'Rename a column, change its work-in-progress limit, or move it to another position (0 = first).',
    inputSchema: object(
      { boardId, column, title: text('New title.'), wipLimit: whole('0 for none.'), position: whole('0 = first.') },
      ['boardId', 'column'],
    ),
    annotations: { idempotentHint: true },
    run: (db, user, a) => {
      const { boardId: id, column: col, ...rest } = a
      return k.updateColumn(db, user, v.ref(id, 'boardId'), v.ref(col, 'column'), v.columnInput(rest, false))
    },
  },
  {
    name: 'delete_column',
    title: 'Delete a column',
    description: 'Delete a column AND every card in it. Move cards out first to keep them.',
    inputSchema: object({ boardId, column }, ['boardId', 'column']),
    annotations: { destructiveHint: true },
    run: async (db, user, a) => {
      await k.deleteColumn(db, user, v.ref(a.boardId, 'boardId'), v.ref(a.column, 'column'))
      return { ok: true }
    },
  },
  {
    name: 'find_cards',
    title: 'Find cards',
    description:
      'Search cards across your boards (or one board). All filters are optional and combine; with none, lists cards in board order.',
    inputSchema: object({
      boardId: text('Only this board.'),
      column: text('Only this column (id or title).'),
      label: text('Only cards with this label (name or id).'),
      priority,
      search: text('Text in the title, notes, checklist, progress updates or interface spec.'),
      dueFrom: text('Due on or after this date, YYYY-MM-DD.'),
      dueTo: text('Due on or before this date, YYYY-MM-DD. Use today for overdue and due today.'),
      assignee: text('Only cards assigned to this team member (name or id), or "none" for unassigned cards.'),
      interfaces: { type: 'boolean', description: 'Only cards that are interfaces to implement (cards with a spec).' },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Most cards to return (default 100).' },
    }),
    annotations: { readOnlyHint: true },
    run: (db, user, a) => k.findCards(db, user, v.cardQuery(a)),
  },
  {
    name: 'get_card',
    title: 'Get a card',
    description: 'Get one card with its column, labels, checklist, progress and progress updates.',
    inputSchema: object({ cardId }, ['cardId']),
    annotations: { readOnlyHint: true },
    run: (db, user, a) => k.getCard(db, user, v.ref(a.cardId, 'cardId')),
  },
  {
    name: 'list_attachments',
    title: 'List attached files',
    description:
      'List the files attached to a card (or to every card on a board), such as interface specs in Word or Excel: name, size, who added it and when. Download a file with GET on its url using the same credentials; upload with POST /api/v1/cards/{cardId}/attachments.',
    inputSchema: object({ cardId: text('Card id; give this or boardId.'), boardId: text('Board id, for every file on it.') }),
    annotations: { readOnlyHint: true },
    run: (db, user, a) =>
      a.cardId !== undefined
        ? k.listAttachments(db, user, { cardId: v.ref(a.cardId, 'cardId') })
        : k.listAttachments(db, user, { boardId: v.ref(a.boardId, 'boardId') }),
  },
  {
    name: 'create_card',
    title: 'Create a card',
    description: 'Add a card to a column, at the bottom unless a position (0 = top) is given.',
    inputSchema: object({ boardId, column, ...cardFields, position: whole('0 = top of the column.') }, [
      'boardId',
      'column',
      'title',
    ]),
    annotations: {},
    run: (db, user, a) => {
      const { boardId: id, ...rest } = a
      return k.createCard(db, user, v.ref(id, 'boardId'), v.cardInput(rest, true), 'request')
    },
  },
  {
    name: 'update_card',
    title: 'Update a card',
    description:
      'Change any of a card’s fields; fields you leave out stay as they are. Giving column and/or position also moves it.',
    inputSchema: object({ cardId, ...cardFields, column, position: whole('0 = top of the column.') }, ['cardId']),
    annotations: { idempotentHint: true },
    run: (db, user, a) => {
      const { cardId: id, ...rest } = a
      return k.updateCard(db, user, v.ref(id, 'cardId'), v.cardInput(rest, false), 'request')
    },
  },
  {
    name: 'move_card',
    title: 'Move a card',
    description: 'Move a card to another column (or within its column), at the bottom unless a position (0 = top) is given.',
    inputSchema: object({ cardId, column, position: whole('0 = top of the column.') }, ['cardId', 'column']),
    annotations: { idempotentHint: true },
    run: (db, user, a) =>
      k.updateCard(db, user, v.ref(a.cardId, 'cardId'), v.cardInput({ column: a.column, position: a.position }, false)),
  },
  {
    name: 'add_progress_note',
    title: 'Add a progress update',
    description:
      'Log a progress update on a card: what was done, and/or a new progress percentage (0-100), which also becomes the card progress. Updates are kept with their time.',
    inputSchema: object(
      { cardId, text: text('What was done or what changed.'), progress: { ...progress, type: 'integer' } },
      ['cardId'],
    ),
    annotations: {},
    run: (db, user, a) => {
      const { cardId: id, ...rest } = a
      return k.addProgressNote(db, user, v.ref(id, 'cardId'), v.progressNoteInput(rest))
    },
  },
  {
    name: 'get_workload',
    title: 'Get team workload',
    description:
      'Who has what: each team member with their open cards (cards not in a done column), counts of overdue and soon-due cards, and load against their capacity (level: free, busy, full or over). Also lists open cards nobody is assigned to. Without boardId, covers every board you can see and joins people with the same name.',
    inputSchema: object({ boardId: text('Only this board (optional).') }),
    annotations: { readOnlyHint: true },
    run: (db, user, a) => k.getWorkload(db, user, a.boardId === undefined ? undefined : v.ref(a.boardId, 'boardId')),
  },
  {
    name: 'set_team_member',
    title: 'Add or change a team member',
    description:
      'Add someone to a board team, or change their name, color or capacity (how many open cards they can take on; 0 = no limit). An unknown name adds that person.',
    inputSchema: object(
      {
        boardId,
        member,
        name: text('New name (to rename).'),
        color: text('Hex color like #0090ff.'),
        capacity: { type: 'integer', minimum: 0, maximum: 999, description: 'Open cards they can take on; 0 = no limit.' },
      },
      ['boardId', 'member'],
    ),
    annotations: { idempotentHint: true },
    run: (db, user, a) => {
      const { boardId: id, member: who, ...rest } = a
      return k.setTeamMember(db, user, v.ref(id, 'boardId'), v.ref(who, 'member'), v.teamMemberInput(rest))
    },
  },
  {
    name: 'remove_team_member',
    title: 'Remove a team member',
    description: 'Take someone off a board team. They are also taken off every card on that board.',
    inputSchema: object({ boardId, member }, ['boardId', 'member']),
    annotations: { destructiveHint: true },
    run: async (db, user, a) => {
      await k.removeTeamMember(db, user, v.ref(a.boardId, 'boardId'), v.ref(a.member, 'member'))
      return { ok: true }
    },
  },
  {
    name: 'delete_card',
    title: 'Delete a card',
    description: 'Delete a card for good.',
    inputSchema: object({ cardId }, ['cardId']),
    annotations: { destructiveHint: true },
    run: async (db, user, a) => {
      await k.deleteCard(db, user, v.ref(a.cardId, 'cardId'))
      return { ok: true }
    },
  },
]

const INSTRUCTIONS =
  'TodoList Kanban boards. Start with list_boards, then get_board to see columns and cards. ' +
  'Columns can be named by title. Cards can be assigned to the board team by name, but each assignment waits for the board owner to approve it in the app (see pendingAssignment on the card); get_workload shows who has what. ' +
  'You act as the owner of the API key: viewers can only read.'

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

async function answer(db: Db, user: User, message: Message): Promise<object | null> {
  if (typeof message !== 'object' || message === null || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    // Responses from the client (we never send requests) need no answer.
    if (message && typeof message === 'object' && ('result' in message || 'error' in message)) return null
    return rpcError(message?.id, -32600, 'Invalid request')
  }
  const isNotification = message.id === undefined
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Args
  const ok = (result: object) => (isNotification ? null : { jsonrpc: '2.0', id: message.id, result })

  switch (message.method) {
    case 'initialize': {
      const requested = params.protocolVersion
      return ok({
        protocolVersion:
          typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'todolist-kanban', title: 'TodoList Kanban', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      })
    }
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: tools.map(({ run: _run, ...tool }) => tool) })
    case 'tools/call': {
      const tool = tools.find((t) => t.name === params.name)
      if (!tool) return isNotification ? null : rpcError(message.id, -32602, `Unknown tool: ${String(params.name)}`)
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Args
      try {
        const result = await tool.run(db, user, args)
        return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
      } catch (error) {
        // Refusals and bad input go back to the agent as a tool error it can read and fix.
        if (error instanceof HTTPException || error instanceof v.BadRequest) {
          return ok({ content: [{ type: 'text', text: error.message }], isError: true })
        }
        throw error
      }
    }
    default:
      if (isNotification) return null
      return rpcError(message.id, -32601, `Method not found: ${message.method}`)
  }
}

export async function handleMcp(c: Context, db: Db, user: User) {
  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return c.json(rpcError(null, -32700, 'Parse error'), 400)
  }
  const messages = Array.isArray(payload) ? payload : [payload]
  const answers: object[] = []
  for (const message of messages) {
    const reply = await answer(db, user, message as Message)
    if (reply) answers.push(reply)
  }
  // Only notifications or responses: accepted, nothing to say.
  if (answers.length === 0) return c.body(null, 202)
  return c.json(Array.isArray(payload) ? answers : answers[0])
}
