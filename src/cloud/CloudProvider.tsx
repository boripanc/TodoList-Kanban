import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStore } from '../state/context'
import type { CloudApi, CloudUser, ReceivedInvite } from './api'
import { CloudContext, type Cloud } from './context'
import { CloudSync } from './sync'

const PENDING_JOIN_KEY = 'todolist-kanban/pending-join'

function readPendingJoin(): string | null {
  try {
    const url = new URL(window.location.href)
    const token = url.searchParams.get('join')
    if (token) {
      localStorage.setItem(PENDING_JOIN_KEY, token)
      url.searchParams.delete('join')
      window.history.replaceState(null, '', url.toString())
    }
    return localStorage.getItem(PENDING_JOIN_KEY)
  } catch {
    return null
  }
}

function clearPendingJoin() {
  try {
    localStorage.removeItem(PENDING_JOIN_KEY)
  } catch {
    // Storage blocked; nothing to clear.
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.')

/**
 * Turns on accounts and sharing when the server answers. If it doesn't (no
 * server running, or the app is hosted without one), the app stays on this
 * device only, with no sign-in.
 */
export function CloudProvider({ api, children }: { api: CloudApi | null; children: ReactNode }) {
  const [available, setAvailable] = useState(false)

  useEffect(() => {
    if (!api) return
    let active = true
    api.getUser().then(
      () => active && setAvailable(true),
      () => {
        if (active) console.info('Accounts are off: the app server did not answer. Boards stay on this device.')
      },
    )
    return () => {
      active = false
    }
  }, [api])

  if (!api || !available) return <>{children}</>
  return <CloudSession api={api}>{children}</CloudSession>
}

function CloudSession({ api, children }: { api: CloudApi; children: ReactNode }) {
  const { state, dispatch, getState } = useStore()
  const [user, setUser] = useState<CloudUser | null | undefined>(undefined)
  const [invites, setInvites] = useState<ReceivedInvite[]>([])
  const [error, setError] = useState<string | null>(null)
  const [joinToken, setJoinToken] = useState<string | null>(readPendingJoin)
  const syncRef = useRef<CloudSync | null>(null)

  const reportError = useCallback((e: unknown) => setError(message(e)), [])
  const saved = useCallback(() => syncRef.current?.idle() ?? Promise.resolve(), [])

  useEffect(() => {
    let active = true
    api.getUser().then(
      (u) => active && setUser(u),
      () => active && setUser(null),
    )
    const unsubscribe = api.onAuthChange((u) =>
      // Token refreshes report the same user again; keep the object stable.
      setUser((prev) => (prev?.id === u?.id ? prev : u)),
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [api])

  const refreshInvites = useCallback(async () => {
    try {
      setInvites(await api.listReceivedInvites())
    } catch (e) {
      console.error(e)
    }
  }, [api])

  const refresh = useCallback(async () => {
    const sync = syncRef.current
    if (!sync) return
    await Promise.all([sync.refreshAll().catch(reportError), refreshInvites()])
  }, [refreshInvites, reportError])

  // One sync engine per signed-in user.
  useEffect(() => {
    if (user === undefined) return
    if (!user) {
      dispatch({ type: 'cloud/clear' })
      return
    }
    const sync = new CloudSync(api, getState, dispatch, setError)
    syncRef.current = sync
    void sync.refreshAll().catch(reportError)
    void refreshInvites()

    const timers = new Map<string, number>()
    const later = (key: string, run: () => void) => {
      window.clearTimeout(timers.get(key))
      timers.set(key, window.setTimeout(run, 300))
    }
    const unsubscribe = api.subscribe(user.id, {
      onBoard: (id) => later(id, () => void sync.refresh(id).catch(reportError)),
      onMembership: () =>
        later('*', () => {
          void sync.refreshAll().catch(reportError)
          void refreshInvites()
        }),
    })
    const onFocus = () => {
      if (document.visibilityState === 'visible') {
        void sync.refreshAll().catch(() => {})
        void refreshInvites()
      }
    }
    document.addEventListener('visibilitychange', onFocus)
    window.addEventListener('focus', onFocus)
    return () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', onFocus)
      window.removeEventListener('focus', onFocus)
      for (const timer of timers.values()) window.clearTimeout(timer)
      sync.stop()
      syncRef.current = null
    }
  }, [api, user, dispatch, getState, refreshInvites, reportError])

  // Send local edits once a burst of changes (like a drag) settles.
  useEffect(() => {
    const timer = window.setTimeout(() => syncRef.current?.push(), 250)
    return () => window.clearTimeout(timer)
  }, [state])

  // Join a board from an invite link once signed in.
  useEffect(() => {
    if (!user || !joinToken) return
    let active = true
    api
      .joinWithLink(joinToken)
      .then(async (boardId) => {
        await syncRef.current?.refreshAll()
        if (active) dispatch({ type: 'board/select', boardId })
      })
      .catch(reportError)
      .finally(() => {
        clearPendingJoin()
        if (active) setJoinToken(null)
      })
    return () => {
      active = false
    }
  }, [api, user, joinToken, dispatch, reportError])

  const value = useMemo<Cloud>(
    () => ({
      api,
      user,
      invites: user ? invites : [],
      pendingJoin: !!joinToken && user === null,
      error,
      clearError: () => setError(null),
      reportError,
      signIn: (email, password) => api.signIn(email, password),
      signUp: (email, password) => api.signUp(email, password),
      signOut: async () => {
        await api.signOut()
        setUser(null)
      },
      createBoard: (action) => {
        dispatch(action)
        dispatch({ type: 'board/setCloud', boardId: action.id, role: 'owner' })
        syncRef.current?.publish(action.id)
      },
      moveToAccount: (boardId) => {
        dispatch({ type: 'board/setCloud', boardId, role: 'owner' })
        syncRef.current?.publish(boardId)
      },
      deleteBoard: (boardId) => {
        syncRef.current?.deleteBoard(boardId)
        dispatch({ type: 'board/delete', boardId })
      },
      leaveBoard: async (boardId) => {
        await api.leaveBoard(boardId)
        syncRef.current?.forget(boardId)
      },
      acceptInvite: async (inviteId) => {
        const boardId = await api.acceptInvite(inviteId)
        await Promise.all([syncRef.current?.refreshAll(), refreshInvites()])
        dispatch({ type: 'board/select', boardId })
      },
      declineInvite: async (inviteId) => {
        await api.declineInvite(inviteId)
        await refreshInvites()
      },
      saved,
      refresh,
    }),
    [api, user, invites, joinToken, error, reportError, saved, dispatch, refresh, refreshInvites],
  )

  return <CloudContext.Provider value={value}>{children}</CloudContext.Provider>
}
