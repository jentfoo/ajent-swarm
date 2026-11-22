import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'

import { useSwarm } from '../providers/swarm'
import { useAuth } from '../providers/auth'
import { useWorkspace } from '../providers/workspace'
import { useNow } from '../hooks/useNow'
import SessionView from '../screens/SessionView'
import { RenameControl } from '../session/RenameControl'
import { tildePath } from '../session/names'
import { relativeTime } from '../session/rewind'
import { useSessionNamer } from '../session/useSessionLabel'
import { sessionDrag, useSessionDrag } from '../ui/dndContext'
import { SessionContextMenu, useSessionMenu } from '../session/SessionContextMenu'
import { useWorkspaceKeys } from './keys'
import { ShortcutOverlay } from './ShortcutOverlay'
import { StatusBadge } from '../session/StatusBadge'
import { attentionSectionTitles, chainNoticeOf, isActionable, sessionBadgeOf } from './attention'
import type { AttentionItem } from './attention'

// FocusedWorkspace answers "what needs me right now": a ranked rail split
// in three queues (states wanting a human answer above, idle agents
// waiting below them, busy sessions last) beside exactly one SessionView.
// Pinned sessions top the rail under their own Pinned section, in pin order
// whatever their live state. Rows are tabbable buttons with an inline
// check-off on actionable ones, matching the j/k shortcuts and mobile's
// switcher rows. Dragging one row
// onto another chains them: the dragged row queues after the target and
// receives its handoff, the rail never reorders. The selected session
// persists in the layout
// profile, recently viewed sessions stay warm in the store, so swapping
// rows is instant.
export default function FocusedWorkspace() {
  const { sessions } = useSwarm()
  const auth = useAuth()
  const {
    needs,
    waiting,
    working,
    acknowledgeItem,
    profile,
    selectFocusedSession,
    setChainDraft,
    pinnedSessionIds,
  } = useWorkspace()
  const { dragging } = useSessionDrag()

  const [searchParams, setSearchParams] = useSearchParams()
  const selected = profile.focused.selectedSessionId

  // Deep links select their session once, then leave the URL clean.
  useEffect(() => {
    const linked = searchParams.get('session')
    if (linked === null) return
    selectFocusedSession(linked)
    setSearchParams({}, { replace: true })
  }, [searchParams, selectFocusedSession, setSearchParams])

  // Pinned sessions lead the rail in pin order whatever their live state;
  // the queues below keep only the unpinned rest.
  const pinnedRows = useMemo(() => {
    const live = [...needs, ...waiting, ...working].filter((item) =>
      pinnedSessionIds.includes(item.sessionId),
    )
    return live.sort(
      (a, b) => pinnedSessionIds.indexOf(a.sessionId) - pinnedSessionIds.indexOf(b.sessionId),
    )
  }, [needs, waiting, working, pinnedSessionIds])
  const unpinned = useMemo(() => {
    const keep = (rows: AttentionItem[]) =>
      rows.filter((item) => !pinnedSessionIds.includes(item.sessionId))
    return { needs: keep(needs), waiting: keep(waiting), working: keep(working) }
  }, [needs, waiting, working, pinnedSessionIds])
  const rows = useMemo(
    () => [...pinnedRows, ...unpinned.needs, ...unpinned.waiting, ...unpinned.working],
    [pinnedRows, unpinned],
  )
  const [cursorId, setCursorId] = useState<string | null>(selected ?? rows[0]?.sessionId ?? null)

  // The cursor follows reality: a row that leaves the queue snaps to the
  // first needs row, an unknown id lands at index zero rather than falling
  // off the list.
  const cursorIndex = Math.max(
    0,
    rows.findIndex((r) => r.sessionId === cursorId),
  )
  const cursor = rows[cursorIndex]?.sessionId ?? null

  const nameFor = useSessionNamer()

  const railRef = useRef<HTMLDivElement>(null)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [chainOver, setChainOver] = useState<string | null>(null)
  const { menu, openSessionMenu, closeSessionMenu } = useSessionMenu()
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

  // The rail's sections in display order, the three queues titled from the
  // shared model. Rows badge their own kind, so a queue never encodes state,
  // empty sections render no title at all.
  const railSections = (
    [
      { id: 'pinned', title: 'Pinned', rows: pinnedRows },
      { id: 'needs', title: attentionSectionTitles.needs, rows: unpinned.needs },
      { id: 'waiting', title: attentionSectionTitles.waiting, rows: unpinned.waiting },
      { id: 'working', title: attentionSectionTitles.working, rows: unpinned.working },
    ] as const
  ).filter((section) => section.rows.length > 0)

  const renderRow = (item: AttentionItem) => {
    const isCursor = item.sessionId === cursor
    const isSelected = item.sessionId === selected
    // the stored swarm title leads, its workspace path sits below in small
    // muted text so long titles keep the whole line
    const row = sessions.find((s) => s.sessionId === item.sessionId)
    const label = nameFor(item.sessionId)
    const chainable = dragging !== null && dragging !== item.sessionId
    return (
      <div
        key={`${item.sessionId}:${item.pid}`}
        role="button"
        tabIndex={0}
        className={`rail-row kind-${item.kind} ${isSelected ? 'selected' : ''} ${
          chainOver === item.sessionId ? 'chain-target' : ''
        }`}
        data-cursor={isCursor || undefined}
        data-session-id={item.sessionId}
        draggable
        onDragStart={(ev) => {
          // inner controls own their gestures: a rename or check-off press
          // never starts a row drag
          if (ev.target !== ev.currentTarget) return
          ev.dataTransfer.setData('text/plain', item.sessionId) // Firefox drags need data
          ev.dataTransfer.effectAllowed = 'link'
          sessionDrag.begin(item.sessionId)
        }}
        onDragEnd={() => {
          setChainOver(null)
          sessionDrag.end()
        }}
        onDragOver={(ev) => {
          // rail drops only chain, they never reorder, so every foreign row
          // highlights as a target while a drag flies
          if (!chainable) return
          ev.preventDefault()
          ev.dataTransfer.dropEffect = 'link'
          setChainOver(item.sessionId)
        }}
        onDragLeave={(ev) => {
          // leaving for a child control is not leaving the row, the highlight
          // holds while the pointer crosses inner buttons
          if (ev.currentTarget.contains(ev.relatedTarget as Node)) return
          if (chainOver === item.sessionId) setChainOver(null)
        }}
        onDrop={(ev) => {
          if (!chainable) return
          ev.preventDefault()
          // the dropped-on row is the parent that hands off, the dragged row
          // queues after it
          setChainDraft({ parentId: item.sessionId, childId: dragging })
          setChainOver(null)
          sessionDrag.end()
        }}
        onClick={() => open(item.sessionId)}
        onContextMenu={(ev) => openSessionMenu(ev, item.sessionId)}
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
            {/* the shared badge derivation: a chained wait outranks plain
                waiting, so queued follow-up sessions never read as idle */}
            <StatusBadge status={sessionBadgeOf(item.running, item)} />
            {/* since=0 is a row without a wait stamp */}
            {item.since > 0 && (
              <span className="muted rail-wait">
                {relativeTime(item.since, now, { bare: true })}
              </span>
            )}
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
            {(chainNoticeOf(item, nameFor) ?? item.reason) ||
              (item.kind === 'working' ? 'working…' : '')}
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
        {railSections.length === 0 ? (
          <p className="muted">No sessions running</p>
        ) : (
          railSections.map((section) => (
            <div className="rail-section" key={section.id}>
              <div className="rail-section-title">
                {section.title} <span className="muted">({section.rows.length})</span>
              </div>
              {section.rows.map((item) => renderRow(item))}
            </div>
          ))
        )}
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
      <SessionContextMenu menu={menu} onClose={closeSessionMenu} />
    </div>
  )
}
