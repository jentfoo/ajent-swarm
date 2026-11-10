import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { fleet } from '../api/endpoints'
import type { AttentionRow, SessionStatus } from '../api/types'
import { usePoll } from '../hooks/usePoll'
import { SessionStore } from '../stream/sessionStore'
import { SwarmStream } from '../stream/swarmStream'
import type { SocketState } from '../stream/swarmStream'

type Theme = 'dark' | 'light'

// Discovery and digest cadences: fast enough that launches, exits and queue
// rows read live, slow enough to stay invisible on the wire. The digest keeps
// a slower background cadence for hidden tabs.
const pollSessionsMs = 2_000
const pollAttentionMs = 2_500
const pollAttentionHiddenMs = 30_000

// Debounce for stream-driven digest refreshes: turn boundaries land several
// frames in quick succession, so the burst coalesces into one fetch.
const digestRefreshMs = 150

interface SwarmContextValue {
  stream: SwarmStream
  store: SessionStore
  sessions: SessionStatus[]
  attention: AttentionRow[]
  connection: SocketState
  theme: Theme
  setTheme: (theme: Theme) => void
  // refreshSessions forces the discovery poll, label edits use it so rows
  // re-render without waiting out the cadence.
  refreshSessions: () => Promise<void>
  // refreshAttention forces the digest poll, acknowledgments use it so settled
  // rows drop now instead of waiting out the cadence.
  refreshAttention: () => Promise<void>
}

const SwarmContext = createContext<SwarmContextValue | null>(null)

// Poll refresher with a staleness guard: overlapping replies can resolve out
// of order, so only the newest one commits and a superseded latecomer drops.
function useNewestPoll<T>(load: () => Promise<T[]>, commit: (rows: T[]) => void) {
  const pollSeq = useRef(0)
  return useCallback(async () => {
    const seq = ++pollSeq.current
    try {
      const rows = await load()
      if (seq !== pollSeq.current) return // a newer poll superseded this reply
      commit(rows)
    } catch {
      // Poll failures surface through the connection banner and next tick.
    }
  }, [load, commit])
}

// SwarmProvider owns app-wide state: the one multiplexed stream connection
// and the session state store, the discovery and attention polls feeding
// badges and the focus queue, and the theme persisted in localStorage.
export function SwarmProvider({ children }: { children: ReactNode }) {
  // One stream per provider, StrictMode's simulated remount only disconnects
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
  // subscribes, runs after the listener above to catch its transitions.
  useEffect(() => stream.connect(), [stream])

  const refreshSessions = useNewestPoll(fleet.sessions, setSessions)
  const refreshAttention = useNewestPoll(fleet.attention, setAttention)

  usePoll(() => void refreshSessions(), pollSessionsMs)
  // The digest keeps a slow background cadence so hidden tabs still raise
  // notifications, everything else stays visible-only.
  usePoll(() => void refreshAttention(), pollAttentionMs, pollAttentionHiddenMs)

  // The chat pane updates straight off the stream, so the digest poll alone
  // leaves the focus queue re-sorting seconds behind what the user just saw.
  // Frames that move a session between queues (a dialog answered, a turn
  // started or ended) refresh the digest right away, keeping the rail in
  // step with the chat, unrelated transcript churn still rides the poll.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = store.onDigestChange(() => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void refreshAttention()
      }, digestRefreshMs)
    })
    return () => {
      unsub()
      if (timer !== null) clearTimeout(timer)
    }
  }, [store, refreshAttention])

  // theme degrades to the preferred scheme when storage is unreadable. The
  // key predates the versioned naming and stays unversioned: index.html's
  // pre-paint script reads it too, a rename must change both.
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      const raw = localStorage.getItem('swarm.theme')
      if (raw === 'dark' || raw === 'light') return raw
    } catch {
      // Storage may be unavailable, the default applies.
    }
    return preferredTheme()
  })

  // index.html's head script applied this value before first paint, the
  // effect owns runtime changes, persistence and installed-chrome color.
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('swarm.theme', theme)
    } catch {
      // Persisting preferences is best effort.
    }
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
      setTheme: setThemeState,
      refreshSessions,
      refreshAttention,
    }),
    [stream, store, sessions, attention, connection, theme, refreshSessions, refreshAttention],
  )

  return <SwarmContext.Provider value={value}>{children}</SwarmContext.Provider>
}

function preferredTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function useSwarm(): SwarmContextValue {
  const ctx = useContext(SwarmContext)
  if (!ctx) throw new Error('useSwarm outside SwarmProvider')
  return ctx
}
