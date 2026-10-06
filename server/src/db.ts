import pg from 'pg'

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
}

/** The database the server needs: queries, transactions and LISTEN. Postgres in production, PGlite in tests. */
export interface Db extends Queryable {
  transaction<T>(run: (tx: Queryable) => Promise<T>): Promise<T>
  listen(channel: string, onMessage: (payload: string) => void): Promise<() => Promise<void>>
  close(): Promise<void>
}

export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString })

  return {
    async query<T>(sql: string, params?: unknown[]) {
      // Without parameters pg uses the simple protocol, which allows several statements (migrations).
      const result = params?.length ? await pool.query(sql, params) : await pool.query(sql)
      return { rows: result.rows as T[] }
    },

    async transaction(run) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        const result = await run({
          async query<T>(sql: string, params?: unknown[]) {
            const r = params?.length ? await client.query(sql, params) : await client.query(sql)
            return { rows: r.rows as T[] }
          },
        })
        await client.query('commit')
        return result
      } catch (error) {
        await client.query('rollback').catch(() => {})
        throw error
      } finally {
        client.release()
      }
    },

    async listen(channel, onMessage) {
      // A dedicated connection, reconnected if it drops, so live updates keep flowing.
      let client: pg.Client | null = null
      let stopped = false
      const connect = async () => {
        if (stopped) return
        try {
          client = new pg.Client({ connectionString })
          client.on('notification', (msg) => msg.channel === channel && msg.payload && onMessage(msg.payload))
          client.on('error', () => {
            client = null
            setTimeout(connect, 2000)
          })
          await client.connect()
          await client.query(`listen ${pg.escapeIdentifier(channel)}`)
        } catch (error) {
          console.error('Live updates: could not listen for changes, retrying', error)
          client = null
          setTimeout(connect, 5000)
        }
      }
      await connect()
      return async () => {
        stopped = true
        await client?.end().catch(() => {})
      }
    },

    close: () => pool.end(),
  }
}
