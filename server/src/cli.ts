// Admin commands. Usage: npm run server:set-password -- someone@example.com 'new password'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { hashPassword, MIN_PASSWORD_LENGTH } from './auth.ts'
import { createPgDb } from './db.ts'

const root = join(import.meta.dirname, '..', '..')
for (const file of ['.env.local', '.env']) {
  const path = join(root, file)
  if (existsSync(path)) process.loadEnvFile(path)
}

const [command, email, password] = process.argv.slice(2)
if (command !== 'set-password' || !email || !password) {
  console.error("Usage: npm run server:set-password -- someone@example.com 'new password'")
  process.exit(1)
}
if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`)
  process.exit(1)
}
const db = createPgDb(process.env.DATABASE_URL ?? '')
const { rows } = await db.query<{ id: string }>(
  'update kanban.users set password_hash = $2 where lower(email) = lower($1) returning id',
  [email, await hashPassword(password)],
)
if (rows[0]) {
  // Sign the person out everywhere, so the old password's sessions and API keys stop working.
  await db.query('delete from kanban.sessions where user_id = $1', [rows[0].id])
  await db.query('delete from kanban.api_keys where user_id = $1', [rows[0].id])
  console.log(`Password changed for ${email}. Their sessions and API keys were revoked.`)
} else {
  console.error(`No account for ${email}.`)
  process.exitCode = 1
}
await db.close()
