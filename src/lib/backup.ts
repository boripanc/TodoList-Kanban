import type { AppState } from '../types'
import { isAppState } from '../state/storage'

export function downloadBackup(state: AppState) {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `kanban-backup-${new Date().toISOString().slice(0, 10)}.json`
  link.click()
  URL.revokeObjectURL(url)
}

export async function readBackup(file: File): Promise<AppState> {
  const parsed: unknown = JSON.parse(await file.text())
  if (!isAppState(parsed)) throw new Error('This file is not a kanban backup.')
  return parsed
}
