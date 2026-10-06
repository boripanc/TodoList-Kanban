import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from './db.ts'

const migrationsDir = join(import.meta.dirname, '..', 'migrations')

/** Apply any migrations in server/migrations that haven't run yet, each in its own transaction. */
export async function migrate(db: Db, log: (message: string) => void = () => {}) {
  await db.query('create schema if not exists kanban')
  await db.query(
    'create table if not exists kanban.schema_migrations (name text primary key, applied_at timestamptz not null default now())',
  )
  const { rows } = await db.query<{ name: string }>('select name from kanban.schema_migrations')
  const applied = new Set(rows.map((r) => r.name))
  for (const name of readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (applied.has(name)) continue
    const sql = readFileSync(join(migrationsDir, name), 'utf8')
    await db.transaction(async (tx) => {
      await tx.query(sql)
      await tx.query('insert into kanban.schema_migrations (name) values ($1)', [name])
    })
    log(`Applied migration ${name}`)
  }
}
