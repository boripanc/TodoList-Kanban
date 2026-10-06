import type { CloudApi } from './api'
import { createServerApi } from './serverApi'

/** The configured backend, or null to run on this device only. */
export function createCloudApi(): CloudApi | null {
  const url = import.meta.env.VITE_API_URL as string | undefined
  return url ? createServerApi(url) : null
}
