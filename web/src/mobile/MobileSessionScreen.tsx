import { useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { sessionBusy } from '../state/eventApplier'
import { Composer } from '../session/Composer'
import { SeatBadge } from '../session/SeatBadge'
import { Notices } from '../session/Notices'
import { isTransientPhase, PhaseBanner } from '../session/phases'
import { QueuedPrompts } from '../session/QueuedPrompts'
import { ModeMenu } from '../session/StatusHeader'
import { StatusBar } from '../session/StatusBar'
import { TranscriptView } from '../session/TranscriptView'
import { useInterruptStream } from '../session/useInterruptStream'
import { useSessionCompose } from '../session/useSessionCompose'
import { useSessionLabel } from '../session/useSessionLabel'
import { useKeyboardInset, keyboardInsetStyle } from '../hooks/useKeyboardInset'
import { useSessionChannel } from '../hooks/useSessionChannel'
import { overlayOpen } from '../ui/overlayStack'
import { useWorkspace } from '../providers/workspace'
import { BottomSheet } from './BottomSheet'
import { ModelChip } from './ModelChip'
import { RewindSheet } from './RewindSheet'
import { SettingsScreen } from './SettingsScreen'
import { horizontallyScrollable } from './scrollable'
import { switcherRoute } from './switcher'
import { SwitcherRows } from './SwitcherRows'
import { ToolsScreen } from './ToolsScreen'
import { TouchDialogDock } from './TouchDialogDock'
import { useSwitcherRows } from './useSwitcherRows'

// edgeSwipePx is how far right a touch starting in the left edge zone must
// travel to reopen the switcher sheet.
const edgeSwipePx = 56

// edgeZonePx is the left strip a swipe must start in.
const edgeZonePx = 24

// MobileSessionScreen drives one session on a phone. The component tree stays
// shared with desktop (TranscriptView, notices, dialogs, queue chips, Composer,
// StatusBar); only the chrome forks: a sticky compact header collapsing to
// the session label and model chip, the working turn's Stop riding beside
// Send, and dialogs as stacked full-width cards above the composer.
//
// The content keys on sessionId, so the route reusing this screen for another
// session presents it as a remount: that session's own draft restores from the
// store while open sheets, menus and toasts reset instead of bleeding across
// sessions.
export default function MobileSessionScreen(): ReactElement {
  const { sessionId = '' } = useParams()
  return <MobileSessionSurface key={sessionId} sessionId={sessionId} />
}

// MobileSessionSurface is one session's mounted presentation; the key above
// makes a session swap a remount, so local state never outlives its session.
function MobileSessionSurface({ sessionId }: { sessionId: string }): ReactElement {
  const { state, phase, loadOlder, dispatch } = useSessionChannel(sessionId)
  const { acknowledgeDialog, acknowledgeTurn } = useWorkspace()
  const snap = state.snapshot

  const {
    draft,
    setDraft,
    placedAbove,
    recallToEdit,
    dialogs,
    composerDisabled,
    disabledReason,
    toasts,
    pushToast,
  } = useSessionCompose(sessionId)
  const [showTools, setShowTools] = useState(false)
  const [showRewind, setShowRewind] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const keyboardInset = useKeyboardInset()

  // Edge-swipe from the left reopens the switcher over any session view; the
  // touch zone is only the first 24px so transcript selection never fights it.
  const edgeStart = useRef<{ x: number; y: number } | null>(null)

  const working = sessionBusy(snap)
  // Escape shares the composer Stop button's guarded fire; sheets and pushed
  // screens gate it through the shared overlay stack, so the interrupt stands
  // down behind any open layer without naming each one
  const { interrupt, inFlight: stopBusy } = useInterruptStream({
    sessionId,
    busy: working,
    onToast: pushToast,
  })
  // the switcher's own label chain, so a rename follows the user into the view
  const label = useSessionLabel(sessionId)

  return (
    <div
      className="session-screen mobile-session"
      style={keyboardInsetStyle(keyboardInset)}
      onTouchStart={(ev) => {
        // one fresh finger seeds a candidate; anything else (a second touch
        // landing mid-gesture, a pinch) kills the pending one. A touch targets
        // the element it began on, so one starting inside a sideways scroller
        // stands down: dragging a long code line scrolls its fence instead of
        // opening the switcher
        const t = ev.touches[0]
        edgeStart.current =
          ev.touches.length === 1 && !horizontallyScrollable(ev.target)
            ? { x: t.clientX, y: t.clientY }
            : null
      }}
      onTouchEnd={(ev) => {
        const start = edgeStart.current
        edgeStart.current = null
        // an open overlay layer owns the screen, so the swipe stands down
        if (start === null || start.x > edgeZonePx || overlayOpen()) return
        // a finger still down or several lifted together was never a swipe
        if (ev.touches.length > 0 || ev.changedTouches.length !== 1) return
        const end = ev.changedTouches[0]
        const dx = end.clientX - start.x
        const dy = Math.abs(end.clientY - start.y)
        // horizontal dominance keeps vertical scrolls from reading as swipes
        if (dx >= edgeSwipePx && dx > dy) {
          setSheetOpen(true)
        }
      }}
      onTouchCancel={() => {
        edgeStart.current = null
      }}
    >
      <header className="mobile-session-header">
        <Link to="/" aria-label="Back to launcher" className="back-link">
          ←
        </Link>
        <span className="session-title">{label}</span>
        <ModelChip sessionId={sessionId} snap={snap} onToast={pushToast} />
        <ModeMenu sessionId={sessionId} mode={snap.permission} onToast={pushToast} />
        {isTransientPhase(phase) && (
          <span className={`badge ${phase === 'resyncing' ? 'warn' : ''}`}>{phase}</span>
        )}
        <span className="spacer" />
        <SeatBadge sessionId={sessionId} seat={snap.seat} compact />
        <button type="button" onClick={() => setShowRewind(true)}>
          Rewind
        </button>
        <button type="button" onClick={() => setShowTools(true)} aria-label="Open tools panel">
          Tools
        </button>
        <button
          type="button"
          onClick={() => setShowSettings(true)}
          aria-label="Agent settings"
          aria-expanded={showSettings}
        >
          ☰
        </button>
      </header>

      {phase === 'ended' && (
        <div className="banner warn" role="status">
          Session ended.{' '}
          <Link to={`/m/read/${encodeURIComponent(sessionId)}`}>Read the transcript</Link> or resume
          from the launcher.
        </div>
      )}
      <PhaseBanner phase={phase} />

      <TranscriptView
        sessionId={sessionId}
        state={state}
        loadOlder={loadOlder}
        pullDownToLatest
        onThinkingToggle={(open) => dispatch({ type: 'liveThinkingToggled', open })}
      />

      <Notices notices={state.notices} />
      <TouchDialogDock
        sessionId={sessionId}
        dialogs={dialogs}
        outcomes={state.resolvedElsewhere}
        onAnsweredLocally={(dialogId) => {
          dispatch({ type: 'dialogAnswered', dialogId })
          acknowledgeDialog(sessionId, dialogId)
        }}
        onOutcomeDismissed={(dialogId) => dispatch({ type: 'outcomeDismissed', dialogId })}
      />
      <QueuedPrompts
        queuedRows={snap.queuedRows ?? []}
        pendings={state.pendings}
        droppedRows={state.droppedRows}
        onEdit={() => void recallToEdit()}
      />
      <Composer
        sessionId={sessionId}
        value={draft}
        onChange={setDraft}
        disabled={composerDisabled}
        disabledReason={disabledReason}
        onSubmit={(line, pendingId) => {
          dispatch({ type: 'pendingSubmitted', pendingId, text: line })
          acknowledgeTurn(sessionId, Date.now())
        }}
        onSubmitFailed={(pendingId) => dispatch({ type: 'pendingFailed', pendingId })}
        stop={working ? { onClick: interrupt, busy: stopBusy } : undefined}
      />
      <StatusBar snap={snap} live={state.live} />

      <ToolsScreen
        sessionId={sessionId}
        snap={snap}
        open={showTools}
        onClose={() => setShowTools(false)}
        onToast={pushToast}
      />
      <SettingsScreen
        sessionId={sessionId}
        open={showSettings}
        onClose={() => setShowSettings(false)}
      />
      <RewindSheet
        sessionId={sessionId}
        open={showRewind}
        onClose={() => setShowRewind(false)}
        // a rewound prompt lands above the draft to edit, announced like every
        // other prefill that merges above existing text
        onPrefill={placedAbove}
        onToast={pushToast}
      />

      {/* the switcher rides over any session view, reopened by edge swipe */}
      <SwitcherOverlay open={sheetOpen} onClose={() => setSheetOpen(false)} />

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}

// SwitcherOverlay is the same bottom sheet the home screen shows, fed by the
// same shared row model so a dialog waiting anywhere is visible before
// switching.
function SwitcherOverlay({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): ReactElement | null {
  const navigate = useNavigate()
  const rows = useSwitcherRows()

  return (
    <BottomSheet open={open} onClose={onClose} label="Session switcher">
      <SwitcherRows
        rows={rows}
        onOpen={(row) => {
          onClose()
          // replacing recycles the sheet's own history entry, so back from
          // the switched session returns here rather than onto a leftover
          navigate(switcherRoute(row), { replace: true })
        }}
      />
    </BottomSheet>
  )
}
