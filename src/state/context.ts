import { createContext, useContext, type Dispatch } from 'react'
import type { AppState } from '../types'
import type { Action } from './reducer'

export interface Store {
  state: AppState
  dispatch: Dispatch<Action>
}

export const StoreContext = createContext<Store | null>(null)

export function useStore(): Store {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useStore must be used inside StoreProvider')
  return store
}
