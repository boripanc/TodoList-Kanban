import type { CloudApi } from './api'
import { createServerApi } from './serverApi'

/**
 * The backend to try, or null for this device only. The app looks for its
 * server at /api unless VITE_API_URL points elsewhere; set VITE_API_URL=off
 * to turn accounts off entirely.
 */
export function createCloudApi(): CloudApi | null {
  const url = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api'
  return url && url !== 'off' ? createServerApi(url) : null
}
