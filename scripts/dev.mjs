// `npm run dev`: starts the app, and the API server too when a database is configured,
// so sign-in and sharing work with one command.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
for (const file of ['.env.local', '.env']) {
  const path = join(root, file)
  if (existsSync(path)) process.loadEnvFile(path)
}

const bin = (name) => join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name)
const children = []
const run = (command, args) => {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  child.on('exit', (code) => {
    for (const other of children) if (other !== child) other.kill()
    process.exit(code ?? 0)
  })
  children.push(child)
}

if (process.env.DATABASE_URL) {
  run(bin('tsx'), ['watch', 'server/src/index.ts'])
} else {
  // Nothing to look for, so the app opens straight away on this device.
  process.env.VITE_API_URL ??= 'off'
  console.log('\nAccounts and sharing are off: set DATABASE_URL in .env or .env.local to turn them on (see README).\n')
}
run(bin('vite'), process.argv.slice(2))

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const child of children) child.kill(signal)
  })
}
