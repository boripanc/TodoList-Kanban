// The signed-in user's own contacts and credentials vault: /api/contacts and /api/credentials.
// Rows belong to one user; every query is limited to the caller's rows. Credentials can only be
// used from the app (a signed-in session), never with an API key or OAuth token, so automation
// and AI agents can't read secrets.
import { randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import type { Contact, Credential, CredentialField, CredentialSecrets } from '../../src/cloud/api.ts'
import type { CredentialKind } from '../../src/lib/credentials.ts'
import { fail, type User } from './access.ts'
import type { Db } from './db.ts'
import * as v from './validate.ts'
import { VaultKeyError, type Vault } from './vault.ts'

type Env = { Variables: { user: User; viaApiKey: boolean } }

interface ContactDbRow {
  id: string
  name: string
  company: string
  job_title: string
  email: string
  phone: string
  website: string
  address: string
  notes: string
  created_at: Date
  updated_at: Date
}

interface CredentialDbRow {
  id: string
  name: string
  kind: CredentialKind
  url: string
  fields: CredentialField[]
  secret: string
  created_at: Date
  updated_at: Date
}

const iso = (d: Date) => new Date(d).toISOString()

const contact = (r: ContactDbRow): Contact => ({
  id: r.id,
  name: r.name,
  company: r.company,
  jobTitle: r.job_title,
  email: r.email,
  phone: r.phone,
  website: r.website,
  address: r.address,
  notes: r.notes,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
})

const credential = (r: CredentialDbRow): Credential => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  url: r.url,
  fields: r.fields,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
})

/** Ids in the path that aren't uuids can't match a row: a 404, like any other unknown id. */
function rowId(value: string, what: string): string {
  try {
    return v.uuid(value)
  } catch {
    return fail(404, `${what} not found`)
  }
}

export function peopleRoutes(db: Db, vault: Vault) {
  const api = new Hono<Env>()
  const user = (c: Context<Env>) => c.get('user')

  const body = async (c: Context) => {
    try {
      return (await c.req.json()) as unknown
    } catch {
      return fail(400, 'Expected JSON')
    }
  }

  // --- Contacts ---

  const contactColumns = 'id, name, company, job_title, email, phone, website, address, notes, created_at, updated_at'

  api.get('/contacts', async (c) => {
    const { rows } = await db.query<ContactDbRow>(
      `select ${contactColumns} from kanban.contacts where user_id = $1 order by lower(name), created_at`,
      [user(c).id],
    )
    return c.json(rows.map(contact))
  })

  api.post('/contacts', async (c) => {
    const input = v.contactInput(await body(c))
    const { rows } = await db.query<ContactDbRow>(
      `insert into kanban.contacts (user_id, name, company, job_title, email, phone, website, address, notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning ${contactColumns}`,
      [user(c).id, input.name, input.company, input.jobTitle, input.email, input.phone, input.website, input.address, input.notes],
    )
    return c.json(contact(rows[0]), 201)
  })

  api.put('/contacts/:id', async (c) => {
    const id = rowId(c.req.param('id'), 'Contact')
    const input = v.contactInput(await body(c))
    const { rows } = await db.query<ContactDbRow>(
      `update kanban.contacts set name = $3, company = $4, job_title = $5, email = $6, phone = $7, website = $8,
         address = $9, notes = $10, updated_at = now()
       where id = $1 and user_id = $2 returning ${contactColumns}`,
      [id, user(c).id, input.name, input.company, input.jobTitle, input.email, input.phone, input.website, input.address, input.notes],
    )
    if (!rows[0]) fail(404, 'Contact not found')
    return c.json(contact(rows[0]))
  })

  api.delete('/contacts/:id', async (c) => {
    const id = rowId(c.req.param('id'), 'Contact')
    const { rows } = await db.query('delete from kanban.contacts where id = $1 and user_id = $2 returning id', [
      id,
      user(c).id,
    ])
    if (!rows[0]) fail(404, 'Contact not found')
    return c.json({ ok: true })
  })

  // --- Credentials (app only) ---

  api.use(async (c, next) => {
    if (c.get('viaApiKey') && /^\/api\/credentials(\/|$)/.test(c.req.path))
      fail(403, 'Credentials can only be opened in the app, not with an API key.')
    await next()
  })

  const context = (userId: string, credentialId: string) => `credential:${userId}:${credentialId}`
  const credentialColumns = 'id, name, kind, url, fields, secret, created_at, updated_at'

  /** Splits fields into what is stored readable (secret values blanked) and the secret values. */
  const split = (fields: CredentialField[], previous: Record<string, string>) => {
    const secrets: Record<string, string> = {}
    const stored = fields.map((f) => {
      if (!f.secret) return f
      secrets[f.name] = f.value ?? previous[f.name] ?? ''
      return { ...f, value: null }
    })
    return { stored, secrets }
  }

  const unseal = async (row: Pick<CredentialDbRow, 'id' | 'secret'>, userId: string) => {
    try {
      return await vault.decrypt<CredentialSecrets>(row.secret, context(userId, row.id))
    } catch (error) {
      if (error instanceof VaultKeyError) fail(409, error.message)
      throw error
    }
  }

  const loadCredential = async (userId: string, id: string) => {
    const { rows } = await db.query<CredentialDbRow>(
      `select ${credentialColumns} from kanban.credentials where id = $1 and user_id = $2`,
      [id, userId],
    )
    return rows[0] ?? fail(404, 'Credential not found')
  }

  api.get('/credentials', async (c) => {
    const { rows } = await db.query<CredentialDbRow>(
      `select ${credentialColumns} from kanban.credentials where user_id = $1 order by lower(name), created_at`,
      [user(c).id],
    )
    return c.json({ credentials: rows.map(credential), keySource: vault.keySource })
  })

  api.post('/credentials', async (c) => {
    const input = v.credentialInput(await body(c), true)
    const userId = user(c).id
    const id = randomUUID()
    const { stored, secrets } = split(input.fields, {})
    const sealed = await vault.encrypt({ fields: secrets, notes: input.notes ?? '' } satisfies CredentialSecrets, context(userId, id))
    const { rows } = await db.query<CredentialDbRow>(
      `insert into kanban.credentials (id, user_id, name, kind, url, fields, secret)
       values ($1, $2, $3, $4, $5, $6, $7) returning ${credentialColumns}`,
      [id, userId, input.name, input.kind, input.url, JSON.stringify(stored), sealed],
    )
    return c.json(credential(rows[0]), 201)
  })

  api.put('/credentials/:id', async (c) => {
    const id = rowId(c.req.param('id'), 'Credential')
    const input = v.credentialInput(await body(c), false)
    const userId = user(c).id
    const row = await loadCredential(userId, id)
    const previous = await unseal(row, userId)
    const { stored, secrets } = split(input.fields, previous.fields)
    const sealed = await vault.encrypt(
      { fields: secrets, notes: input.notes ?? previous.notes } satisfies CredentialSecrets,
      context(userId, id),
    )
    const { rows } = await db.query<CredentialDbRow>(
      `update kanban.credentials set name = $3, kind = $4, url = $5, fields = $6, secret = $7, updated_at = now()
       where id = $1 and user_id = $2 returning ${credentialColumns}`,
      [id, userId, input.name, input.kind, input.url, JSON.stringify(stored), sealed],
    )
    if (!rows[0]) fail(404, 'Credential not found')
    return c.json(credential(rows[0]))
  })

  api.get('/credentials/:id/secret', async (c) => {
    const id = rowId(c.req.param('id'), 'Credential')
    const userId = user(c).id
    c.header('Cache-Control', 'no-store')
    return c.json(await unseal(await loadCredential(userId, id), userId))
  })

  api.delete('/credentials/:id', async (c) => {
    const id = rowId(c.req.param('id'), 'Credential')
    const { rows } = await db.query('delete from kanban.credentials where id = $1 and user_id = $2 returning id', [
      id,
      user(c).id,
    ])
    if (!rows[0]) fail(404, 'Credential not found')
    return c.json({ ok: true })
  })

  return api
}
