import { useSyncExternalStore } from 'react'
import { loadSettings, subscribe, type Settings } from '../lib/settings'

// `useSyncExternalStore` is the right primitive for an external mutable store
// like our settings module: it's stable under React 18+ concurrent rendering
// and guarantees every consumer sees the same snapshot within a render. The
// alternative (useState + useEffect subscription) can tear when a mutation
// fires while React is mid-commit.
export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, loadSettings, loadSettings)
}
