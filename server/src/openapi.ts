// OpenAPI description of the REST API in server/src/rest.ts, served at
// GET /api/v1/openapi.json. Keep the two in step.

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
const query = (name: string, description: string, schema: object = { type: 'string' }) => ({
  name,
  in: 'query',
  required: false,
  description,
  schema,
})
const priority = { type: 'string', enum: ['none', 'low', 'medium', 'high', 'urgent'] }
const date = { type: 'string', format: 'date', example: '2026-12-31' }
const cardFilters = [
  query('column', 'Column id or title'),
  query('label', 'Label name or id'),
  query('priority', 'Priority', priority),
  query('search', 'Text in the title, notes or checklist'),
  query('dueFrom', 'Due on or after (YYYY-MM-DD)', date),
  query('dueTo', 'Due on or before (YYYY-MM-DD)', date),
  query('limit', 'Most cards to return (1-500, default 100)', { type: 'integer', minimum: 1, maximum: 500 }),
]
const cardFields = {
  title: { type: 'string' },
  description: { type: 'string', description: 'Notes' },
  priority,
  dueDate: { ...date, nullable: true, description: 'null or "" clears it' },
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
            dueDate: { ...date, nullable: true },
            labels: { type: 'array', items: ref('Label') },
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
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  }
}
