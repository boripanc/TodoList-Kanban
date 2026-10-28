// OpenAPI description of the REST API in server/src/rest.ts, served at
// GET /api/v1/openapi.json. Keep the two in step.
import { adapterTypes, messageModes, specStatuses } from '../../src/lib/interfaces.ts'
import { attachmentCategories } from '../../src/lib/attachments.ts'

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const json = (schema: object, description = 'OK') => ({ description, content: { 'application/json': { schema } } })
const body = (schema: object) => ({ required: true, content: { 'application/json': { schema } } })
const ok = json({ type: 'object', properties: { ok: { type: 'boolean' } } })
const errors = {
  400: { $ref: '#/components/responses/BadRequest' },
  401: { $ref: '#/components/responses/Unauthorized' },
  403: { $ref: '#/components/responses/Forbidden' },
  404: { $ref: '#/components/responses/NotFound' },
}
const pathParam = (name: string, description: string) => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: { type: 'string' },
})
const boardId = pathParam('boardId', 'Board id')
const column = pathParam('column', 'Column id or title')
const cardId = pathParam('cardId', 'Card id')
const member = pathParam('member', 'Team member id or name')
const query = (name: string, description: string, schema: object = { type: 'string' }) => ({
  name,
  in: 'query',
  required: false,
  description,
  schema,
})
const priority = { type: 'string', enum: ['none', 'low', 'medium', 'high', 'urgent'] }
const date = { type: 'string', format: 'date', example: '2026-12-31' }
const categoryProperty = {
  type: 'string',
  enum: attachmentCategories,
  default: 'other',
  description: 'Which part of the interface spec the file is: technical spec, mapping spec or other',
}

const specProperties = {
  senderSystem: { type: 'string', description: 'System that sends the message, e.g. S/4HANA PRD' },
  senderAdapter: { type: 'string', enum: adapterTypes, description: 'CPI sender adapter' },
  receiverSystem: { type: 'string', description: 'System that receives it, e.g. Salesforce' },
  receiverAdapter: { type: 'string', enum: adapterTypes, description: 'CPI receiver adapter' },
  mode: { type: 'string', enum: messageModes, description: 'async or sync' },
  endpoint: { type: 'string', description: 'iFlow name or address, IDoc type or folder' },
  notes: { type: 'string', description: 'Auth, error handling, retries, volume, schedule' },
  status: { type: 'string', enum: specStatuses, description: 'draft, review or agreed' },
}
const cardFilters = [
  query('column', 'Column id or title'),
  query('label', 'Label name or id'),
  query('priority', 'Priority', priority),
  query('search', 'Text in the title, notes, checklist, progress updates or interface spec'),
  query('dueFrom', 'Due on or after (YYYY-MM-DD)', date),
  query('dueTo', 'Due on or before (YYYY-MM-DD)', date),
  query('assignee', 'Team member name or id, or "none" for unassigned cards'),
  query('interfaces', 'true for only cards that are interfaces to implement (cards with a spec)', { type: 'boolean' }),
  query('limit', 'Most cards to return (1-500, default 100)', { type: 'integer', minimum: 1, maximum: 500 }),
]
const cardFields = {
  title: { type: 'string' },
  description: { type: 'string', description: 'Notes' },
  priority,
  startDate: {
    ...date,
    nullable: true,
    description: 'When work starts; null or "" clears it. Cards labelled R4C or Project need both startDate and dueDate.',
  },
  dueDate: {
    ...date,
    nullable: true,
    description: 'The end date; null or "" clears it. Cards labelled R4C or Project need both startDate and dueDate.',
  },
  estimateDays: {
    type: 'number',
    nullable: true,
    minimum: 0,
    exclusiveMinimum: true,
    maximum: 999,
    description:
      'Estimated effort in man-days (MD). For cards not labelled R4C or Project, the due date is worked out from the start date and this (weekdays only), and the start date is set to today when the card moves into an in-progress column.',
  },
  labels: {
    type: 'array',
    items: { type: 'string' },
    description: 'Label names or ids; names the board does not have yet become new labels. Replaces the card labels.',
  },
  checklist: {
    type: 'array',
    description: 'Replaces the whole checklist. Items are text or {text, done}.',
    items: {
      oneOf: [
        { type: 'string' },
        { type: 'object', required: ['text'], properties: { text: { type: 'string' }, done: { type: 'boolean' } } },
      ],
    },
  },
  progress: { type: 'integer', minimum: 0, maximum: 100, nullable: true, description: 'Percent done; null stops tracking' },
  assignees: {
    type: 'array',
    items: { type: 'string' },
    description: 'Team member names or ids; names the team does not have yet join it. Replaces the assignees.',
  },
  spec: {
    type: 'object',
    nullable: true,
    properties: specProperties,
    description:
      'Technical spec when the card is an interface someone implements. Only the fields given change; a card without a spec gets one (idoc to http, async, draft by default). null removes it.',
  },
  column: { type: 'string', description: 'Column id or title' },
  position: { type: 'integer', minimum: 0, description: '0 = top of the column; default the bottom' },
}

export function openApiSpec() {
  return {
    openapi: '3.0.3',
    info: {
      title: 'TodoList Kanban API',
      version: '1.0.0',
      description:
        'Manage boards, columns and cards. Authenticate with an API key from the app (Account menu → API keys) ' +
        'in an `X-API-Key: kbn_...` header (or `Authorization: Bearer kbn_...`). A key acts as its owner: viewers can read, editors and owners can change, ' +
        'only owners can delete a board. The same operations are available to AI agents over MCP at POST /api/mcp.',
    },
    servers: [{ url: '/api/v1' }],
    security: [{ apiKey: [] }, { bearerAuth: [] }],
    paths: {
      '/me': { get: { summary: 'Who the API key belongs to', operationId: 'getMe', responses: { 200: json(ref('User')), 401: errors[401] } } },
      '/boards': {
        get: {
          summary: 'List boards you can see',
          operationId: 'listBoards',
          responses: { 200: json({ type: 'array', items: ref('BoardSummary') }), 401: errors[401] },
        },
        post: {
          summary: 'Create a board',
          operationId: 'createBoard',
          requestBody: body({
            type: 'object',
            required: ['title'],
            properties: {
              title: { type: 'string' },
              columns: { type: 'array', items: { type: 'string' }, description: 'Default: To do, In progress, Done' },
              labels: {
                type: 'array',
                items: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, color: { type: 'string', example: '#0090ff' } } },
              },
            },
          }),
          responses: { 201: json(ref('Board'), 'Created'), ...errors },
        },
      },
      '/boards/{boardId}': {
        parameters: [boardId],
        get: { summary: 'Get a board with columns and cards', operationId: 'getBoard', responses: { 200: json(ref('Board')), ...errors } },
        patch: {
          summary: 'Rename a board',
          operationId: 'updateBoard',
          requestBody: body({ type: 'object', properties: { title: { type: 'string' } } }),
          responses: { 200: json(ref('Board')), ...errors },
        },
        delete: { summary: 'Delete a board (owner only)', operationId: 'deleteBoard', responses: { 200: ok, ...errors } },
      },
      '/boards/{boardId}/team/{member}': {
        parameters: [boardId, member],
        put: {
          summary: 'Add or change a team member',
          description: 'An unknown name adds that person. Fields left out stay as they are.',
          operationId: 'setTeamMember',
          requestBody: body({
            type: 'object',
            properties: {
              name: { type: 'string', description: 'New name (to rename)' },
              color: { type: 'string', example: '#0090ff' },
              capacity: { type: 'integer', minimum: 0, maximum: 999, description: 'Open cards they can take on; 0 = no limit' },
            },
          }),
          responses: { 200: json(ref('TeamMember')), ...errors },
        },
        delete: {
          summary: 'Remove a team member',
          description: 'Also takes them off every card on the board.',
          operationId: 'removeTeamMember',
          responses: { 200: ok, ...errors },
        },
      },
      '/boards/{boardId}/workload': {
        parameters: [boardId],
        get: {
          summary: "Each team member's open cards and load on this board",
          operationId: 'getBoardWorkload',
          responses: { 200: json(ref('Workload')), ...errors },
        },
      },
      '/workload': {
        get: {
          summary: 'Workload across all your boards',
          description: 'People with the same name on different boards count as one person; capacities add up.',
          operationId: 'getWorkload',
          responses: { 200: json(ref('Workload')), ...errors },
        },
      },
      '/boards/{boardId}/columns': {
        parameters: [boardId],
        post: {
          summary: 'Add a column',
          operationId: 'createColumn',
          requestBody: body({
            type: 'object',
            required: ['title'],
            properties: {
              title: { type: 'string' },
              wipLimit: { type: 'integer', minimum: 0, description: '0 for no limit' },
              position: { type: 'integer', minimum: 0, description: '0 = first; default last' },
            },
          }),
          responses: { 201: json(ref('Column'), 'Created'), ...errors },
        },
      },
      '/boards/{boardId}/columns/{column}': {
        parameters: [boardId, column],
        patch: {
          summary: 'Rename, set the limit of, or move a column',
          operationId: 'updateColumn',
          requestBody: body({
            type: 'object',
            properties: { title: { type: 'string' }, wipLimit: { type: 'integer', minimum: 0 }, position: { type: 'integer', minimum: 0 } },
          }),
          responses: { 200: json(ref('Column')), ...errors },
        },
        delete: { summary: 'Delete a column and its cards', operationId: 'deleteColumn', responses: { 200: ok, ...errors } },
      },
      '/boards/{boardId}/cards': {
        parameters: [boardId],
        get: {
          summary: 'List or search cards on a board',
          operationId: 'listBoardCards',
          parameters: cardFilters,
          responses: { 200: json({ type: 'array', items: ref('Card') }), ...errors },
        },
        post: {
          summary: 'Create a card',
          operationId: 'createCard',
          requestBody: body({ type: 'object', required: ['column', 'title'], properties: cardFields }),
          responses: { 201: json(ref('Card'), 'Created'), ...errors },
        },
      },
      '/cards': {
        get: {
          summary: 'Search cards on all your boards',
          operationId: 'findCards',
          parameters: [query('boardId', 'Only this board'), ...cardFilters],
          responses: { 200: json({ type: 'array', items: ref('Card') }), ...errors },
        },
      },
      '/cards/{cardId}': {
        parameters: [cardId],
        get: { summary: 'Get a card', operationId: 'getCard', responses: { 200: json(ref('Card')), ...errors } },
        patch: {
          summary: 'Update or move a card',
          description: 'Fields left out stay as they are. Giving column and/or position moves the card.',
          operationId: 'updateCard',
          requestBody: body({ type: 'object', properties: cardFields }),
          responses: { 200: json(ref('Card')), ...errors },
        },
        delete: { summary: 'Delete a card', operationId: 'deleteCard', responses: { 200: ok, ...errors } },
      },
      '/boards/{boardId}/attachments': {
        parameters: [boardId],
        get: {
          summary: 'Files attached to cards on a board',
          operationId: 'listBoardAttachments',
          responses: { 200: json({ type: 'array', items: ref('Attachment') }), ...errors },
        },
      },
      '/cards/{cardId}/attachments': {
        parameters: [cardId],
        get: {
          summary: 'Files attached to a card',
          operationId: 'listCardAttachments',
          responses: { 200: json({ type: 'array', items: ref('Attachment') }), ...errors },
        },
        post: {
          summary: 'Attach a file to a card',
          description:
            'Word, Excel, PowerPoint, PDF, CSV, text, XML/XSD/WSDL, JSON, ZIP or an image, up to 10 MB. Needs editor or owner role.',
          operationId: 'addAttachment',
          requestBody: body({
            type: 'object',
            required: ['name', 'data'],
            properties: {
              name: { type: 'string', example: 'IF_S4_ORDERS05_spec.docx', description: 'File name; its extension sets the type' },
              data: { type: 'string', format: 'byte', description: 'The file contents, base64' },
              category: categoryProperty,
            },
          }),
          responses: { 201: json(ref('Attachment'), 'Attached'), ...errors },
        },
      },
      '/attachments/{attachmentId}': {
        parameters: [pathParam('attachmentId', 'Attachment id')],
        get: {
          summary: 'Download a file',
          operationId: 'getAttachment',
          responses: {
            200: { description: 'The file', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
            ...errors,
          },
        },
        patch: {
          summary: 'Move a file to another part of the spec',
          description: 'Needs editor or owner role.',
          operationId: 'updateAttachment',
          requestBody: body({ type: 'object', required: ['category'], properties: { category: categoryProperty } }),
          responses: { 200: json(ref('Attachment')), ...errors },
        },
        delete: { summary: 'Remove a file', operationId: 'deleteAttachment', responses: { 200: ok, ...errors } },
      },
      '/cards/{cardId}/progress': {
        parameters: [cardId],
        post: {
          summary: 'Add a progress update',
          description: 'Logs what was done and/or a new progress percentage, which also becomes the card progress.',
          operationId: 'addProgressNote',
          requestBody: body({
            type: 'object',
            properties: {
              text: { type: 'string', description: 'What was done or what changed' },
              progress: { type: 'integer', minimum: 0, maximum: 100 },
            },
          }),
          responses: { 201: json(ref('Card'), 'Added'), ...errors },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'API key (kbn_...)' },
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'The same API key as a Bearer token' },
      },
      responses: {
        BadRequest: json(ref('Error'), 'The request body or query is not valid'),
        Unauthorized: json(ref('Error'), 'Missing, unknown or revoked API key'),
        Forbidden: json(ref('Error'), 'Your role on the board does not allow this'),
        NotFound: json(ref('Error'), 'No such board, column or card, or you cannot see it'),
      },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'string' } } },
        User: { type: 'object', properties: { id: { type: 'string' }, email: { type: 'string' } } },
        Role: { type: 'string', enum: ['owner', 'editor', 'viewer'] },
        Label: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, color: { type: 'string' } } },
        TeamMember: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            color: { type: 'string' },
            capacity: { type: 'integer', description: 'Open cards they can take on; 0 = no limit' },
          },
        },
        WorkloadCard: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            boardId: { type: 'string' },
            board: { type: 'string' },
            column: { type: 'string' },
            priority,
            dueDate: { ...date, nullable: true },
            progress: { type: 'integer', nullable: true },
          },
        },
        Workload: {
          type: 'object',
          properties: {
            boards: {
              type: 'array',
              items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } },
            },
            members: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  memberIds: { type: 'array', items: { type: 'string' } },
                  name: { type: 'string' },
                  color: { type: 'string' },
                  capacity: { type: 'integer' },
                  level: { type: 'string', enum: ['free', 'busy', 'full', 'over'] },
                  openCount: { type: 'integer', description: 'Assigned cards not in a done column' },
                  overdue: { type: 'integer' },
                  dueSoon: { type: 'integer', description: 'Open cards due within 7 days' },
                  doneCount: { type: 'integer' },
                  openCards: { type: 'array', items: ref('WorkloadCard') },
                },
              },
            },
            unassigned: { type: 'array', items: ref('WorkloadCard'), description: 'Open cards nobody is assigned to' },
          },
        },
        BoardSummary: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            role: ref('Role'),
            cardCount: { type: 'integer' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        Board: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            role: ref('Role'),
            labels: { type: 'array', items: ref('Label') },
            team: { type: 'array', items: ref('TeamMember') },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
            columns: { type: 'array', items: ref('Column') },
          },
        },
        Column: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            wipLimit: { type: 'integer' },
            position: { type: 'integer' },
            cards: { type: 'array', items: ref('Card') },
          },
        },
        Attachment: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            cardId: { type: 'string' },
            name: { type: 'string' },
            type: { type: 'string', description: 'Media type' },
            size: { type: 'integer', description: 'Bytes' },
            category: categoryProperty,
            uploadedBy: { type: 'string', nullable: true, description: 'Email of who added it' },
            uploadedAt: { type: 'string', format: 'date-time' },
            url: { type: 'string', description: 'Download address (GET, same credentials)' },
          },
        },
        Card: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            boardId: { type: 'string' },
            columnId: { type: 'string' },
            column: { type: 'string', description: 'Column title' },
            position: { type: 'integer' },
            title: { type: 'string' },
            description: { type: 'string' },
            priority,
            startDate: { ...date, nullable: true },
            dueDate: { ...date, nullable: true, description: 'The end date' },
            estimateDays: { type: 'number', nullable: true, description: 'Estimated effort in man-days' },
            labels: { type: 'array', items: ref('Label') },
            assignees: {
              type: 'array',
              items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
            },
            pendingAssignment: {
              type: 'object',
              nullable: true,
              description:
                'An assignment asked for through MCP, waiting for the board owner to approve it in the app. Assignments through this REST API take effect right away.',
              properties: {
                assignees: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', nullable: true, description: 'Null for a name that joins the team on approval' },
                      name: { type: 'string' },
                    },
                  },
                },
                requestedBy: { type: 'string', nullable: true, description: 'Email of the account that asked' },
                requestedAt: { type: 'string', format: 'date-time' },
              },
            },
            checklist: {
              type: 'array',
              items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, done: { type: 'boolean' } } },
            },
            progress: { type: 'integer', minimum: 0, maximum: 100, nullable: true, description: 'Percent done; null when not tracked' },
            progressLog: {
              type: 'array',
              description: 'Progress updates, oldest first',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  progress: { type: 'integer', nullable: true },
                  at: { type: 'string', format: 'date-time' },
                },
              },
            },
            spec: {
              type: 'object',
              nullable: true,
              description: 'The technical spec when the card is an interface to implement',
              properties: specProperties,
            },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  }
}
