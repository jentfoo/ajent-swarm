import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { fleet } from '../api/endpoints'
import type { AttentionRow, SessionStatus } from '../api/types'
import { usePoll } from '../hooks/usePoll'
import { SessionStore } from '../stream/sessionStore'
import { SwarmStream } from '../stream/swarmStream'
import type { SocketState } from '../stream/swarmStream'

export type Theme = 'dark' | 'light'

// Discovery and digest cadences: fast enough that launches, exits and inbox
// rows read live, slow enough to stay invisible on the wire. The digest keeps
// a slower background cadence for hidden tabs.
const pollSessionsMs = 2_000
const pollAttentionMs = 2_500
const pollAttentionHiddenMs = 30_000

interface SwarmContextValue {
  stream: SwarmStream
  store: SessionStore
  sessions: SessionStatus[]
  attention: AttentionRow[]
  connection: SocketState
  theme: Theme
  setTheme: (theme: Theme) => void
  // refreshSessions forces the discovery poll; label edits use it so rows
  // re-render without waiting out the cadence.
  refreshSessions: () => Promise<void>
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
// badges and the inbox, and the theme persisted in localStorage.
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

  // index.html's head script applied this value before first paint; the
  // effect owns runtime changes, persistence and installed-chrome color.
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    writeStored('swarm.theme', theme)
    // installed web app chrome follows the in-app setting, not just prefers-
    // color-scheme, so add-to-home-screen keeps one consistent surface
    const meta = document.querySelector('meta[data-theme-color]')
    meta?.setAttribute('content', theme === 'dark' ? '#101216' : '#f6f7f9')
  }, [theme])

  const value = useMemo<SwarmContextValue>(
    () => ({
      stream,
      store,
      sessions,
      attention,
      connection,
      theme,
      setTheme: (t) => setThemeState(t),
      refreshSessions: refreshSessions,
    }),
    [stream, store, sessions, attention, connection, theme, refreshSessions],
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
