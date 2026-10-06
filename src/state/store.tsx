import { useEffect, useReducer, type ReactNode } from 'react'
import type { AppState } from '../types'
import { reducer } from './reducer'
import { loadState, saveState } from './storage'
import { StoreContext } from './context'

export function StoreProvider({ children, initial }: { children: ReactNode; initial?: AppState }) {
  const [state, dispatch] = useReducer(reducer, initial, (seed) => seed ?? loadState())

  useEffect(() => {
    // Drags dispatch many moves in a row; write once things settle.
    const timer = window.setTimeout(() => saveState(state), 150)
    return () => window.clearTimeout(timer)
  }, [state])

  return <StoreContext.Provider value={{ state, dispatch }}>{children}</StoreContext.Provider>
}
