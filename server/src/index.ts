// Starts the TodoList Kanban server: the API for accounts and shared boards,
// plus the built app from dist/ when it exists.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { createApp } from './app.ts'
import { createPgDb } from './db.ts'
import { EventHub } from './events.ts'
import { migrate } from './migrate.ts'

const root = join(import.meta.dirname, '..', '..')
for (const file of ['.env.local', '.env']) {
  const path = join(root, file)
  if (existsSync(path)) process.loadEnvFile(path)
}

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('Set DATABASE_URL to your Postgres connection string (see .env.example).')
  process.exit(1)
}
const port = Number(process.env.PORT ?? 8787)

const db = createPgDb(databaseUrl)
await migrate(db, console.log)
const events = new EventHub(db)
await events.start()

const server = new Hono()
server.route(
  '/',
  createApp({ db, events, secureCookies: process.env.COOKIE_SECURE === 'true', publicUrl: process.env.PUBLIC_URL }),
)

const dist = join(root, 'dist')
if (existsSync(dist)) {
  server.use('/*', serveStatic({ root: 'dist' }))
  server.get('/*', serveStatic({ path: 'dist/index.html' }))
}

serve({ fetch: server.fetch, port }, () => {
  console.log(`TodoList Kanban server on http://localhost:${port}`)
  if (!existsSync(dist))
    console.log('No dist/ folder: run the app with `npm run dev`, or `npm run build` to serve it from here.')
})
