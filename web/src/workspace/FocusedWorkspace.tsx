import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'

import { useSwarm } from '../providers/swarm'
import { useAuth } from '../providers/auth'
import { useWorkspace } from '../providers/workspace'
import SessionView from '../screens/SessionView'
import { RenameControl } from '../session/RenameControl'
import { displayName, shortID, tildePath } from '../session/names'
import { useWorkspaceKeys } from './keys'
import { ShortcutOverlay } from './ShortcutOverlay'
import type { AttentionItem } from './attention'

// FocusedWorkspace answers "what needs me right now": a ranked rail of
// attention (open dialogs by oldest wait, then unreviewed completions newest
// first, agents waiting for a prompt after those) beside exactly one
// SessionView. The selected session persists in the layout profile; recently
// viewed sessions stay warm in the store, so swapping rows is instant.
export default function FocusedWorkspace() {
  const { sessions } = useSwarm()
  const auth = useAuth()
  const { needs, awaiting, working, acknowledgeItem, profile, selectFocusedSession } =
    useWorkspace()

  const [searchParams, setSearchParams] = useSearchParams()
  const selected = profile.focused.selectedSessionId

  // Deep links select their session once, then leave the URL clean.
  useEffect(() => {
    const linked = searchParams.get('session')
    if (linked === null) return
    selectFocusedSession(linked)
    setSearchParams({}, { replace: true })
  }, [searchParams, selectFocusedSession, setSearchParams])

  const rows = useMemo(() => [...needs, ...awaiting, ...working], [needs, awaiting, working])
  const [cursorId, setCursorId] = useState<string | null>(selected ?? rows[0]?.sessionId ?? null)

  // The cursor follows reality: a row that leaves the queue moves to the next.
  const cursorIndex = Math.max(
    0,
    rows.findIndex((r) => r.sessionId === cursorId),
  )
  const cursor = rows[cursorIndex]?.sessionId ?? null

  const nameFor = useCallback(
    (sessionId: string) => {
      const s = sessions.find((row) => row.sessionId === sessionId)
      return s ? displayName(s, auth.home) : shortID(sessionId)
    },
    [sessions, auth.home],
  )

  const railRef = useRef<HTMLDivElement>(null)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const now = useNow(15_000)

  const open = useCallback(
    (sessionId: string) => {
      selectFocusedSession(sessionId)
      setCursorId(sessionId)
    },
    [selectFocusedSession],
  )

  useWorkspaceKeys({
    onNext: () => setCursorId(rows[Math.min(cursorIndex + 1, rows.length - 1)]?.sessionId ?? null),
    onPrevious: () => setCursorId(rows[Math.max(cursorIndex - 1, 0)]?.sessionId ?? null),
    onOpen: () => {
      if (cursor) open(cursor)
    },
    onReview: () => {
      const item = rows[cursorIndex]
      if (item) acknowledgeItem(item)
    },
    onDigit: (position) => setCursorId(rows[position - 1]?.sessionId ?? cursor),
    onEscape: () => {
      railRef.current?.querySelector<HTMLElement>('[data-cursor="true"]')?.focus()
    },
    onShortcuts: () => setShowShortcuts(true),
  })

  // Keep the keyboard cursor visible while it moves.
  useEffect(() => {
    railRef.current
      ?.querySelector<HTMLElement>('[data-cursor="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const renderRow = (item: AttentionItem, section: 'needs' | 'below') => {
    const isCursor = item.sessionId === cursor
    const isSelected = item.sessionId === selected
    // the stored swarm title leads, its workspace path sits below in small
    // muted text so long titles keep the whole line
    const row = sessions.find((s) => s.sessionId === item.sessionId)
    return (
      <div
        key={item.sessionId}
        role="button"
        tabIndex={-1}
        className={`rail-row kind-${section === 'needs' ? item.kind : 'below'} ${isSelected ? 'selected' : ''}`}
        data-cursor={isCursor || undefined}
        data-session-id={item.sessionId}
        onClick={() => open(item.sessionId)}
      >
        <span className="rail-top">
          <span className="rail-name">{nameFor(item.sessionId)}</span>
          <RenameControl sessionId={item.sessionId} label={nameFor(item.sessionId)} />
          <span className="rail-meta">
            {item.kind === 'needs-input' && <span className="badge danger">input</span>}
            {item.kind === 'needs-review' && <span className="badge warn">review</span>}
            {section === 'below' ? (
              item.running ? (
                <span className="badge accent">running</span>
              ) : (
                <span className="badge">idle</span>
              )
            ) : (
              item.kind === 'awaiting' && <span className="badge">waiting</span>
            )}
            {section === 'needs' && item.since > 0 && (
              <span className="muted rail-wait">{waited(item.since, now)}</span>
            )}
          </span>
        </span>
        {row?.workspace && (
          <span className="rail-path muted" title={row.workspace}>
            {tildePath(row.workspace, auth.home)}
          </span>
        )}
        <span className="rail-reason">
          {item.reason || (section === 'below' ? 'working…' : '')}
        </span>
      </div>
    )
  }

  return (
    <div className="workspace focused-workspace">
      <div className="focus-rail" ref={railRef} aria-label="Focus queue">
        <div className="rail-section">
          <div className="rail-section-title">
            Needs input{' '}
            {needs.length + awaiting.length > 0 && (
              <span className="muted">({needs.length + awaiting.length})</span>
            )}
          </div>
          {needs.length + awaiting.length === 0 && (
            <div className="rail-empty muted">Nothing waits on you.</div>
          )}
          {[...needs, ...awaiting].map((item) => renderRow(item, 'needs'))}
        </div>
        <div className="rail-section">
          <div className="rail-section-title">
            Working {working.length > 0 && <span className="muted">({working.length})</span>}
          </div>
          {working.length === 0 && <div className="rail-empty muted">No busy sessions.</div>}
          {working.map((item) => renderRow(item, 'below'))}
        </div>
      </div>

      <div className="workspace-main">
        {selected ? (
          <SessionView sessionId={selected} />
        ) : (
          <div className="workspace-placeholder muted">
            <p>Select a session from the rail.</p>
            <p className="rail-hint">j/k to move · Enter to open · ? for shortcuts</p>
          </div>
        )}
      </div>

      {showShortcuts && <ShortcutOverlay mode="focused" onClose={() => setShowShortcuts(false)} />}
    </div>
  )
}

// useNow ticks occasionally so "waited 3m" lines stay honest without a
// re-render per second.
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

function waited(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h`
}
