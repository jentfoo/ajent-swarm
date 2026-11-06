import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'

import { useSwarm } from '../providers/swarm'
import { useAuth } from '../providers/auth'
import { useWorkspace } from '../providers/workspace'
import { useNow } from '../hooks/useNow'
import SessionView from '../screens/SessionView'
import { RenameControl } from '../session/RenameControl'
import { displayName, shortID, tildePath } from '../session/names'
import { useWorkspaceKeys } from './keys'
import { ShortcutOverlay } from './ShortcutOverlay'
import { attentionSectionTitles } from './attention'
import type { AttentionItem, AttentionKind } from './attention'

// FocusedWorkspace answers "what needs me right now": a ranked rail of
// attention split by urgency — dialogs, unreviewed completions, idle agents,
// busy sessions last — beside exactly one SessionView. The selected session
// persists in the layout profile; recently viewed sessions stay warm in the
// store, so swapping rows is instant.
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

  // The combined actionable bucket splits per urgency: dialogs need an answer
  // now, completions want review, and each renders under its own heading.
  const needsInput = needs.filter((i) => i.kind === 'needs-input')
  const needsReview = needs.filter((i) => i.kind === 'needs-review')

  // The rail's fixed sections in display order, titled from the shared model.
  // The first section's empty note stays quiet unless nothing waits anywhere.
  const railSections: { kind: AttentionKind; rows: AttentionItem[]; empty?: string }[] = [
    {
      kind: 'needs-input',
      rows: needsInput,
      empty: needs.length + awaiting.length === 0 ? 'Nothing waits on you.' : undefined,
    },
    { kind: 'needs-review', rows: needsReview },
    { kind: 'awaiting', rows: awaiting },
    { kind: 'working', rows: working, empty: 'No busy sessions.' },
  ]

  const renderRow = (item: AttentionItem) => {
    const isCursor = item.sessionId === cursor
    const isSelected = item.sessionId === selected
    // only the working class sits outside the attention sections; its rows
    // keep the plain below styling they have always carried
    const below = item.kind === 'working'
    // the stored swarm title leads, its workspace path sits below in small
    // muted text so long titles keep the whole line
    const row = sessions.find((s) => s.sessionId === item.sessionId)
    return (
      <div
        key={`${item.sessionId}:${item.pid}`}
        role="button"
        tabIndex={-1}
        className={`rail-row kind-${below ? 'below' : item.kind} ${isSelected ? 'selected' : ''}`}
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
            {below ? (
              item.running ? (
                <span className="badge accent">running</span>
              ) : (
                <span className="badge">idle</span>
              )
            ) : (
              item.kind === 'awaiting' && <span className="badge">waiting</span>
            )}
            {!below && item.since > 0 && (
              <span className="muted rail-wait">{waited(item.since, now)}</span>
            )}
          </span>
        </span>
        {row?.workspace && (
          <span className="rail-path muted" title={row.workspace}>
            {tildePath(row.workspace, auth.home)}
          </span>
        )}
        <span className="rail-reason">{item.reason || (below ? 'working…' : '')}</span>
      </div>
    )
  }

  return (
    <div className="workspace focused-workspace">
      <div className="focus-rail" ref={railRef} aria-label="Focus queue">
        {railSections.map((section) => (
          <div className="rail-section" key={section.kind}>
            <div className="rail-section-title">
              {attentionSectionTitles[section.kind]}{' '}
              {section.rows.length > 0 && <span className="muted">({section.rows.length})</span>}
            </div>
            {section.rows.length === 0 && section.empty && (
              <div className="rail-empty muted">{section.empty}</div>
            )}
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
