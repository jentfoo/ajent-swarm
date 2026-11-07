import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { ApiError, onUnauthorized } from '../api/client'
import { auth } from '../api/endpoints'

export type AuthStatus = 'loading' | 'bootstrap' | 'anon' | 'authed'

export interface AuthContextValue {
  status: AuthStatus
  username?: string
  home?: string // the service host's home directory, for ~-relative paths
  login: (username: string, password: string) => Promise<void>
  bootstrap: (password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

// AuthProvider resolves the gate state from /api/me once per mount and keeps
// watching for session expiry: any 401 from any call drops back to anon so
// expired sessions land on the login screen with the current location kept.
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [principal, setPrincipal] = useState<{ username?: string; home?: string }>({})

  useEffect(() => {
    let alive = true
    auth
      .me()
      .then((me) => {
        if (!alive) return
        setStatus('authed')
        setPrincipal({ username: me.username, home: me.home })
      })
      .catch((err: unknown) => {
        if (!alive) return
        setStatus(
          err instanceof ApiError && err.code === 'bootstrap_required' ? 'bootstrap' : 'anon',
        )
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(
    () =>
      onUnauthorized(() => {
        // An expired session surfaces anywhere; the login screen reads the
        // current location from the router to restore it afterwards.
        setStatus((prev) => (prev === 'authed' ? 'anon' : prev))
      }),
    [],
  )

  const login = useCallback(async (username: string, password: string) => {
    await auth.login(username, password)
    const me = await auth.me()
    setPrincipal({ username: me.username, home: me.home })
    setStatus('authed')
  }, [])

  const bootstrap = useCallback(async (password: string) => {
    // Bootstrap sets the first password but issues no session; the login
    // screen takes over once the gate clears.
    await auth.bootstrap(password)
    setStatus('anon')
  }, [])

  const logout = useCallback(async () => {
    try {
      await auth.logout()
    } finally {
      setPrincipal({})
      setStatus('anon')
    }
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      username: principal.username,
      home: principal.home,
      login,
      bootstrap,
      logout,
    }),
    [status, principal.username, principal.home, login, bootstrap, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth outside AuthProvider')
  return ctx
}
