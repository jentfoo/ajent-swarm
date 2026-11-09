import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'

import { useSwarm } from '../providers/swarm'
import { useAuth } from '../providers/auth'
import { useWorkspace } from '../providers/workspace'
import { useNow } from '../hooks/useNow'
import SessionView from '../screens/SessionView'
import { RenameControl } from '../session/RenameControl'
import { tildePath } from '../session/names'
import { useSessionNamer } from '../session/useSessionLabel'
import { useWorkspaceKeys } from './keys'
import { ShortcutOverlay } from './ShortcutOverlay'
import { attentionSectionTitles, isActionable } from './attention'
import type { AttentionItem } from './attention'

// FocusedWorkspace answers "what needs me right now": a ranked rail split
// in three queues (states wanting a human answer above, idle agents
// waiting below them, busy sessions last) beside exactly one SessionView.
// Rows are tabbable buttons with an inline check-off on actionable ones,
// matching the j/k shortcuts and mobile's switcher rows. The selected
// session persists in the layout profile, recently viewed sessions stay
// warm in the store, so swapping rows is instant.
export default function FocusedWorkspace() {
  const { sessions } = useSwarm()
  const auth = useAuth()
  const { needs, waiting, working, acknowledgeItem, profile, selectFocusedSession } = useWorkspace()

  const [searchParams, setSearchParams] = useSearchParams()
  const selected = profile.focused.selectedSessionId

  // Deep links select their session once, then leave the URL clean.
  useEffect(() => {
    const linked = searchParams.get('session')
    if (linked === null) return
    selectFocusedSession(linked)
    setSearchParams({}, { replace: true })
  }, [searchParams, selectFocusedSession, setSearchParams])

  const rows = useMemo(() => [...needs, ...waiting, ...working], [needs, waiting, working])
  const [cursorId, setCursorId] = useState<string | null>(selected ?? rows[0]?.sessionId ?? null)

  // The cursor follows reality: a row that leaves the queue moves to the next.
  const cursorIndex = Math.max(
    0,
    rows.findIndex((r) => r.sessionId === cursorId),
  )
  const cursor = rows[cursorIndex]?.sessionId ?? null

  const nameFor = useSessionNamer()

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
    // Escape reaches here only when the viewed session claimed nothing: an
    // interrupt wins first, otherwise the rail row takes the caret
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

  // The rail's three queues in display order, titled from the shared model.
  // Rows badge their own kind, so a queue never encodes state, empty queues
  // render no section at all.
  const railSections = (
    [
      { queue: 'needs', rows: needs },
      { queue: 'waiting', rows: waiting },
      { queue: 'working', rows: working },
    ] as const
  ).filter((section) => section.rows.length > 0)

  const renderRow = (item: AttentionItem) => {
    const isCursor = item.sessionId === cursor
    const isSelected = item.sessionId === selected
    // the stored swarm title leads, its workspace path sits below in small
    // muted text so long titles keep the whole line
    const row = sessions.find((s) => s.sessionId === item.sessionId)
    const label = nameFor(item.sessionId)
    return (
      <div
        key={`${item.sessionId}:${item.pid}`}
        role="button"
        tabIndex={0}
        className={`rail-row kind-${item.kind} ${isSelected ? 'selected' : ''}`}
        data-cursor={isCursor || undefined}
        data-session-id={item.sessionId}
        onClick={() => open(item.sessionId)}
        onKeyDown={(ev) => {
          // a tabbable row activates itself like the native button it imitates
          // preventDefault stands the global Enter binding down, inner controls
          // keep their own activation
          if (ev.target !== ev.currentTarget) return
          if (ev.key !== 'Enter' && ev.key !== ' ') return
          ev.preventDefault()
          open(item.sessionId)
        }}
      >
        <span className="rail-top">
          <span className="rail-name">{label}</span>
          <RenameControl sessionId={item.sessionId} label={label} />
          <span className="rail-meta">
            {item.kind === 'needs-input' && <span className="badge danger">input</span>}
            {item.kind === 'needs-review' && <span className="badge warn">review</span>}
            {item.kind === 'awaiting' && <span className="badge">waiting</span>}
            {item.kind === 'working' &&
              (item.running ? (
                <span className="badge accent">running</span>
              ) : (
                <span className="badge">idle</span>
              ))}
            {item.since > 0 && <span className="muted rail-wait">{waited(item.since, now)}</span>}
          </span>
        </span>
        {row?.workspace && (
          <span className="rail-path muted" title={row.workspace}>
            {tildePath(row.workspace, auth.home)}
          </span>
        )}
        {/* the check-off mirrors mobile's switcher: one shared ack path,
            settled on every device */}
        <span className="rail-bottom">
          <span className="rail-reason">
            {item.reason || (item.kind === 'working' ? 'working…' : '')}
          </span>
          {isActionable(item.kind) && (
            <button
              type="button"
              className="rail-check"
              aria-label={`Mark ${label} reviewed`}
              onClick={(ev) => {
                ev.stopPropagation()
                acknowledgeItem(item)
              }}
            >
              ✓
            </button>
          )}
        </span>
      </div>
    )
  }

  return (
    <div className="workspace focused-workspace">
      <div className="focus-rail" ref={railRef} aria-label="Focus queue">
        {railSections.map((section) => (
          <div className="rail-section" key={section.queue}>
            <div className="rail-section-title">
              {attentionSectionTitles[section.queue]}{' '}
              <span className="muted">({section.rows.length})</span>
            </div>
            {section.rows.map((item) => renderRow(item))}
          </div>
        ))}
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

// waited renders one wait duration the rail reads at a glance.
function waited(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h`
}
