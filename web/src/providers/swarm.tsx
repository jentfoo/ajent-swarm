import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { fleet } from '../api/endpoints'
import type { AttentionRow, SessionStatus } from '../api/types'
import { usePoll } from '../hooks/usePoll'
import { SessionStore } from '../stream/sessionStore'
import { SwarmStream } from '../stream/swarmStream'
import type { SocketState } from '../stream/swarmStream'

export type Theme = 'dark' | 'light'
export type Density = 'compact' | 'cozy'

const pollSessionsMs = 4_000
const pollAttentionMs = 5_000
const pollAttentionHiddenMs = 30_000

interface SwarmContextValue {
  stream: SwarmStream
  store: SessionStore
  sessions: SessionStatus[]
  attention: AttentionRow[]
  connection: SocketState
  theme: Theme
  density: Density
  setTheme: (theme: Theme) => void
  setDensity: (density: Density) => void
}

const SwarmContext = createContext<SwarmContextValue | null>(null)

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw !== null && allowed.includes(raw as T)) return raw as T
  } catch {
    // Storage may be unavailable; the default applies.
  }
  return fallback
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Persisting preferences is best effort.
  }
}

// SwarmProvider owns app-wide state: the one multiplexed stream connection
// and the session state store, the discovery and attention polls feeding
// badges and the inbox, and theme and density persisted in localStorage.
export function SwarmProvider({ children }: { children: ReactNode }) {
  // One stream per provider; StrictMode's simulated remount only disconnects
  // it, and a fresh subscribe reconnects on demand.
  const [stream] = useState(() => new SwarmStream())
  useEffect(() => () => stream.disconnect(), [stream])
  // The store owns every session's reconciled state and warm subscriptions.
  const [store] = useState(() => new SessionStore(stream))
  useEffect(() => () => store.dispose(), [store])

  const [sessions, setSessions] = useState<SessionStatus[]>([])
  const [attention, setAttention] = useState<AttentionRow[]>([])
  const [connection, setConnection] = useState<SocketState>('closed')

  useEffect(
    () => stream.onConnectionChange(() => setConnection(stream.connectionState())),
    [stream],
  )
  // Connect eagerly so the banner tracks the real socket even before a view
  // subscribes; runs after the listener above to catch its transitions.
  useEffect(() => stream.connect(), [stream])

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await fleet.sessions())
    } catch {
      // Poll failures surface through the connection banner and next tick.
    }
  }, [])

  const refreshAttention = useCallback(async () => {
    try {
      setAttention(await fleet.attention())
    } catch {
      // Same as sessions: transient poll failure, retry on the next tick.
    }
  }, [])

  usePoll(() => void refreshSessions(), pollSessionsMs)
  // The digest keeps a slow background cadence so hidden tabs still raise
  // notifications; everything else stays visible-only.
  usePoll(() => void refreshAttention(), pollAttentionMs, pollAttentionHiddenMs)

  const [theme, setThemeState] = useState<Theme>(() =>
    readStored('swarm.theme', ['dark', 'light'] as const, preferredTheme()),
  )
  const [density, setDensityState] = useState<Density>(() =>
    readStored('swarm.density', ['compact', 'cozy'] as const, 'cozy'),
  )

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    writeStored('swarm.theme', theme)
  }, [theme])
  useEffect(() => {
    document.documentElement.dataset.density = density
    writeStored('swarm.density', density)
  }, [density])

  const value = useMemo<SwarmContextValue>(
    () => ({
      stream,
      store,
      sessions,
      attention,
      connection,
      theme,
      density,
      setTheme: (t) => setThemeState(t),
      setDensity: (d) => setDensityState(d),
    }),
    [stream, store, sessions, attention, connection, theme, density],
  )

  return <SwarmContext.Provider value={value}>{children}</SwarmContext.Provider>
}

function preferredTheme(): Theme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function useSwarm(): SwarmContextValue {
  const ctx = useContext(SwarmContext)
  if (!ctx) throw new Error('useSwarm outside SwarmProvider')
  return ctx
}
