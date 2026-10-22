// Encrypts credential secrets at rest with AES-256-GCM. The key comes from the
// CREDENTIALS_KEY setting; without one, the server generates a key and keeps it
// in kanban.vault_keys, which still keeps secrets out of plain sight in backups
// and query results, but not from someone who has the whole database.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { Queryable } from './db.ts'

export type KeySource = 'env' | 'database'

const DATABASE_KEY_ID = 'db'
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest()

export class VaultKeyError extends Error {}

export class Vault {
  private envKey?: { id: string; key: Buffer }
  private databaseKey?: Promise<Buffer>
  private db: Queryable

  constructor(db: Queryable, credentialsKey?: string) {
    this.db = db
    const secret = credentialsKey?.trim()
    if (secret) {
      const key = sha256(secret)
      // A fingerprint, so a secret saved under another key is recognised instead of failing to decrypt.
      this.envKey = { id: `k${sha256(key).toString('hex').slice(0, 12)}`, key }
    }
  }

  get keySource(): KeySource {
    return this.envKey ? 'env' : 'database'
  }

  private loadDatabaseKey(): Promise<Buffer> {
    this.databaseKey ??= (async () => {
      await this.db.query('insert into kanban.vault_keys (id, key) values ($1, $2) on conflict (id) do nothing', [
        DATABASE_KEY_ID,
        randomBytes(32).toString('base64'),
      ])
      const { rows } = await this.db.query<{ key: string }>('select key from kanban.vault_keys where id = $1', [
        DATABASE_KEY_ID,
      ])
      return Buffer.from(rows[0].key, 'base64')
    })().catch((error: unknown) => {
      this.databaseKey = undefined
      throw error
    })
    return this.databaseKey
  }

  private async key(id?: string): Promise<{ id: string; key: Buffer }> {
    if (id === undefined) return this.envKey ?? { id: DATABASE_KEY_ID, key: await this.loadDatabaseKey() }
    if (id === DATABASE_KEY_ID) return { id, key: await this.loadDatabaseKey() }
    if (this.envKey?.id === id) return this.envKey
    throw new VaultKeyError(
      'This credential was saved with a different CREDENTIALS_KEY. Restore that key on the server to open it.',
    )
  }

  /** `context` (owner and credential id) is bound to the ciphertext, so a value can't be moved to another row. */
  async encrypt(value: unknown, context: string): Promise<string> {
    const { id, key } = await this.key()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(context))
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    return ['v1', id, iv, cipher.getAuthTag(), data]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
      .join('.')
  }

  async decrypt<T>(sealed: string, context: string): Promise<T> {
    const [version, id, iv, tag, data] = sealed.split('.')
    if (version !== 'v1' || !id || !iv || !tag || data === undefined) throw new VaultKeyError('Unreadable credential')
    const { key } = await this.key(id)
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
    decipher.setAAD(Buffer.from(context))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    try {
      const plain = Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()])
      return JSON.parse(plain.toString('utf8')) as T
    } catch {
      throw new VaultKeyError('This credential could not be decrypted.')
    }
  }
}
