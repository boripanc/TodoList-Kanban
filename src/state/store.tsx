import { useCallback, useEffect, useReducer, useRef, type ReactNode } from 'react'
import type { AppState } from '../types'
import { reducer, type Action } from './reducer'
import { loadState, saveState } from './storage'
import { StoreContext } from './context'

export function StoreProvider({ children, initial }: { children: ReactNode; initial?: AppState }) {
  const [state, rawDispatch] = useReducer(reducer, initial, (seed) => seed ?? loadState())
  // The latest state, updated as soon as an action is dispatched, for code that
  // runs right after a dispatch (cloud sync) and can't wait for a render.
  const latest = useRef(state)

  const dispatch = useCallback((action: Action) => {
    latest.current = reducer(latest.current, action)
    rawDispatch(action)
  }, [])
  const getState = useCallback(() => latest.current, [])

  useEffect(() => {
    // Drags dispatch many moves in a row; write once things settle.
    const timer = window.setTimeout(() => saveState(state), 150)
    return () => window.clearTimeout(timer)
  }, [state])

  return <StoreContext.Provider value={{ state, dispatch, getState }}>{children}</StoreContext.Provider>
}
