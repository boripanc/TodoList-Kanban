// REST API for automation tools such as n8n: /api/v1/... with an API key
// (`X-API-Key: kbn_...` or `Authorization: Bearer kbn_...`) or a signed-in session. Described by
// /api/v1/openapi.json (server/src/openapi.ts).
import { Hono, type Context } from 'hono'
import type { User } from './access.ts'
import type { Db } from './db.ts'
import * as k from './kanban.ts'
import { BadRequest } from './validate.ts'
import * as v from './validate.ts'

type Env = { Variables: { user: User } }

export function restApi(db: Db) {
  const api = new Hono<Env>()
  const user = (c: Context<Env>) => c.get('user')

  /** The JSON body; an empty body counts as {} so a PATCH or POST with nothing to say still works. */
  const body = async (c: Context): Promise<unknown> => {
    const text = await c.req.text()
    if (!text.trim()) return {}
    try {
      return JSON.parse(text)
    } catch {
      throw new BadRequest('Expected JSON')
    }
  }

  api.get('/me', (c) => c.json(user(c)))

  api.get('/boards', async (c) => c.json(await k.listBoards(db, user(c))))
  api.post('/boards', async (c) => c.json(await k.createBoard(db, user(c), v.newBoardInput(await body(c))), 201))
  api.get('/boards/:boardId', async (c) => c.json(await k.getBoard(db, user(c), c.req.param('boardId'))))
  api.patch('/boards/:boardId', async (c) =>
    c.json(await k.updateBoard(db, user(c), c.req.param('boardId'), v.boardPatchInput(await body(c)))),
  )
  api.delete('/boards/:boardId', async (c) => {
    await k.deleteBoard(db, user(c), c.req.param('boardId'))
    return c.json({ ok: true })
  })

  api.post('/boards/:boardId/columns', async (c) =>
    c.json(await k.createColumn(db, user(c), c.req.param('boardId'), v.columnInput(await body(c), true)), 201),
  )
  api.patch('/boards/:boardId/columns/:column', async (c) =>
    c.json(
      await k.updateColumn(db, user(c), c.req.param('boardId'), c.req.param('column'), v.columnInput(await body(c), false)),
    ),
  )
  api.delete('/boards/:boardId/columns/:column', async (c) => {
    await k.deleteColumn(db, user(c), c.req.param('boardId'), c.req.param('column'))
    return c.json({ ok: true })
  })

  api.get('/boards/:boardId/cards', async (c) =>
    c.json(await k.findCards(db, user(c), v.cardQuery({ ...c.req.query(), boardId: c.req.param('boardId') }))),
  )
  api.post('/boards/:boardId/cards', async (c) =>
    c.json(await k.createCard(db, user(c), c.req.param('boardId'), v.cardInput(await body(c), true)), 201),
  )

  api.get('/cards', async (c) => c.json(await k.findCards(db, user(c), v.cardQuery(c.req.query()))))
  api.get('/cards/:cardId', async (c) => c.json(await k.getCard(db, user(c), c.req.param('cardId'))))
  api.patch('/cards/:cardId', async (c) =>
    c.json(await k.updateCard(db, user(c), c.req.param('cardId'), v.cardInput(await body(c), false))),
  )
  api.delete('/cards/:cardId', async (c) => {
    await k.deleteCard(db, user(c), c.req.param('cardId'))
    return c.json({ ok: true })
  })

  return api
}
