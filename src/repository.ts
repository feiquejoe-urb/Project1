import { cloudRepository } from './cloudRepository'
import { localRepository } from './db'

const wantsCloud = import.meta.env.VITE_DATA_MODE === 'cloud'

if (wantsCloud && !import.meta.env.VITE_SUPABASE_URL) {
  console.warn('Cloud data mode was requested without Supabase configuration; using local storage.')
}

export const isCloudMode = wantsCloud && Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY)
export const repository = isCloudMode ? cloudRepository : localRepository
