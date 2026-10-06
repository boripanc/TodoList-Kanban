import type { CloudApi } from './api'
import { createSupabaseApi } from './supabaseApi'

/** The configured backend, or null to run on this device only. */
export function createCloudApi(): CloudApi | null {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
  if (!url || !key) return null
  return createSupabaseApi(url, key)
}
