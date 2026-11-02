import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { fleet } from '../api/endpoints'
import type { AttentionRow, SessionStatus } from '../api/types'
import { usePoll } from '../hooks/usePoll'
import { SwarmStream } from '../stream/swarmStream'
import type { SocketState } from '../stream/swarmStream'
import { noopBridge } from './notifications'
import type { NotificationBridge } from './notifications'

export type Theme = 'dark' | 'light'
export type Density = 'compact' | 'cozy'

const pollSessionsMs = 4_000
const pollAttentionMs = 5_000

interface SwarmContextValue {
  stream: SwarmStream
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

// SwarmProvider owns app-wide state: the one multiplexed stream connection,
// the discovery and attention polls feeding badges and later the inbox, theme
// and density persisted in localStorage, and the notification bridge stub.
export function SwarmProvider({ children }: { children: ReactNode }) {
  // One stream per provider; StrictMode's simulated remount only disconnects
  // it, and a fresh subscribe reconnects on demand.
  const [stream] = useState(() => new SwarmStream())
  useEffect(() => () => stream.disconnect(), [stream])

  const [sessions, setSessions] = useState<SessionStatus[]>([])
  const [attention, setAttention] = useState<AttentionRow[]>([])
  const [connection, setConnection] = useState<SocketState>('closed')
  const bridgeRef = useRef<NotificationBridge>(noopBridge())

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
      const rows = await fleet.attention()
      setAttention(rows)
      bridgeRef.current.publish(rows)
    } catch {
      // Same as sessions: transient poll failure, retry on the next tick.
    }
  }, [])

  usePoll(() => void refreshSessions(), pollSessionsMs)
  usePoll(() => void refreshAttention(), pollAttentionMs)

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
      sessions,
      attention,
      connection,
      theme,
      density,
      setTheme: (t) => setThemeState(t),
      setDensity: (d) => setDensityState(d),
    }),
    [stream, sessions, attention, connection, theme, density],
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
