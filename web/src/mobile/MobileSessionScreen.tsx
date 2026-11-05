import { useCallback, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { sessions as sessionAPI } from '../api/endpoints'
import { ApiError } from '../api/client'
import { sessionBusy } from '../state/eventApplier'
import { Composer } from '../session/Composer'
import { placedAboveNotice, useComposerDraft } from '../session/useComposerDraft'
import { Notices } from '../session/Notices'
import { QueuedPrompts } from '../session/QueuedPrompts'
import { ModeMenu } from '../session/StatusHeader'
import { StatusBar } from '../session/StatusBar'
import { TranscriptView } from '../session/TranscriptView'
import { useKeyboardInset, keyboardInsetStyle } from '../hooks/useKeyboardInset'
import { useSessionChannel } from '../hooks/useSessionChannel'
import { useWorkspace } from '../providers/workspace'
import { BottomSheet } from './BottomSheet'
import { ModelChip } from './ModelChip'
import { RewindSheet } from './RewindSheet'
import { SettingsSheet } from './SettingsSheet'
import { SwitcherRows } from './SwitcherRows'
import { ToolsSheet } from './ToolsSheet'
import { TouchDialogDock } from './TouchDialogDock'
import { dismissSwipeHint, swipeHintSeen } from './swipeHint'
import { useSwitcherRows } from './useSwitcherRows'

// edgeSwipePx is how far right a touch starting in the left edge zone must
// travel to reopen the switcher sheet.
const edgeSwipePx = 56

interface Toast {
  id: number
  text: string
  level: 'info' | 'error'
}

// MobileSessionScreen drives one session on a phone. The component tree stays
// shared with desktop (TranscriptView, notices, dialogs, queue chips, Composer,
// StatusBar); only the chrome forks: a sticky compact header collapsing to
// model plus spinner and dialogs as stacked full-width cards above the
// composer.
//
// The content keys on sessionId, so the route reusing this screen for another
// session presents it as a remount: that session's own draft restores from the
// store while open sheets, menus and toasts reset instead of bleeding across
// sessions (session-switch-state-reset.md).
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

  const { draft, setDraft, prefill } = useComposerDraft(sessionId)
  const [showTools, setShowTools] = useState(false)
  const [showRewind, setShowRewind] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [stopBusy, setStopBusy] = useState(false)
  const [showSwipeHint, setShowSwipeHint] = useState(() => !swipeHintSeen())
  const keyboardInset = useKeyboardInset()

  // the hint retires once, then stays retired through the persisted flag
  const retireSwipeHint = () => {
    setShowSwipeHint(false)
    dismissSwipeHint()
  }

  // Edge-swipe from the left reopens the switcher over any session view; the
  // touch zone is only the first 24px so transcript selection never fights it.
  const edgeStart = useRef<{ x: number; y: number } | null>(null)

  const [toasts, setToasts] = useState<Toast[]>([])
  const toastID = useRef(0)
  const pushToast = useCallback((text: string, level: 'info' | 'error' = 'info') => {
    const id = ++toastID.current
    setToasts((ts) => [...ts.slice(-4), { id, text, level }])
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 6_000)
  }, [])

  // placedAbove surfaces a prefill that merged above an existing draft, so the
  // arrival is noticed instead of reading as one's own text moving down.
  const placedAbove = useCallback(
    (text: string) => {
      if (prefill(text)) pushToast(placedAboveNotice, 'info')
    },
    [prefill, pushToast],
  )

  // Editing a queued prompt pops it back into the composer through recall;
  // failures surface through the toast stack like every other refusal.
  const recallToEdit = useCallback(async () => {
    try {
      const row = await sessionAPI.recall(sessionId)
      if (row.text) placedAbove(row.text)
    } catch (err) {
      pushToast(err instanceof ApiError ? err.message : 'Recall failed.', 'error')
    }
  }, [sessionId, pushToast, placedAbove])

  const interrupt = useCallback(async () => {
    setStopBusy(true)
    try {
      await sessionAPI.interrupt(sessionId)
    } catch (err) {
      pushToast(err instanceof ApiError ? err.message : 'Interrupt failed.', 'error')
    } finally {
      setStopBusy(false)
    }
  }, [sessionId, pushToast])

  const dialogs = snap.interactions ?? []
  const composerDisabled = phase !== 'live' || dialogs.length > 0
  const working = sessionBusy(snap)
  const disabledReason =
    dialogs.length > 0
      ? 'A dialog needs an answer before prompts can send.'
      : 'The session is not reachable right now.'

  return (
    <div
      className="session-screen mobile-session"
      style={keyboardInsetStyle(keyboardInset)}
      onTouchStart={(ev) => {
        // one fresh finger seeds a candidate; anything else (a second touch
        // landing mid-gesture, a pinch) kills the pending one
        const t = ev.touches[0]
        edgeStart.current = ev.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null
      }}
      onTouchEnd={(ev) => {
        const start = edgeStart.current
        edgeStart.current = null
        if (start === null || start.x > 24 || showRewind || showTools || showSettings) return
        // a finger still down or several lifted together was never a swipe
        if (ev.touches.length > 0 || ev.changedTouches.length !== 1) return
        const end = ev.changedTouches[0]
        const dx = (end?.clientX ?? 0) - start.x
        const dy = Math.abs((end?.clientY ?? 0) - start.y)
        // horizontal dominance keeps vertical scrolls from reading as swipes
        if (dx >= edgeSwipePx && dx > dy) {
          setSheetOpen(true)
          retireSwipeHint()
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
        <ModelChip sessionId={sessionId} snap={snap} onToast={pushToast} />
        <ModeMenu sessionId={sessionId} mode={snap.permission} onToast={pushToast} />
        {phase !== 'live' && phase !== 'ended' && (
          <span className={`badge ${phase === 'resyncing' ? 'warn' : ''}`}>{phase}</span>
        )}
        {working && (
          <button type="button" onClick={() => void interrupt()} disabled={stopBusy}>
            {stopBusy ? 'Stopping…' : 'Interrupt'}
          </button>
        )}
        <span className="spacer" />
        <SeatClaim
          sessionId={sessionId}
          held={snap.seat.held && !snap.seat.yours}
          holder={snap.seat.holder}
        />
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
        {showSwipeHint && (
          <button type="button" className="muted edge-swipe-hint" onClick={retireSwipeHint}>
            Tip: swipe from the left edge to switch sessions
          </button>
        )}
      </header>

      {phase === 'ended' && (
        <div className="banner warn" role="status">
          Session ended.{' '}
          <Link to={`/m/read/${encodeURIComponent(sessionId)}`}>Read the transcript</Link> or resume
          from the launcher.
        </div>
      )}
      {phase !== 'live' && phase !== 'ended' && (
        <div className="banner info" role="status">
          Returning to the app will refresh what you see here.
        </div>
      )}

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
      />
      <StatusBar snap={snap} live={state.live} />

      <ToolsSheet
        sessionId={sessionId}
        snap={snap}
        open={showTools}
        onClose={() => setShowTools(false)}
        onToast={pushToast}
      />
      <SettingsSheet
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
          if (row.status === 'ended') navigate(`/m/read/${encodeURIComponent(row.sessionId)}`)
          else navigate(`/s/${encodeURIComponent(row.sessionId)}`)
        }}
      />
    </BottomSheet>
  )
}

// SeatClaim is the compact takeover affordance: shown only while someone
// else holds the write seat, since a free seat costs nothing to use and one
// this connection holds is not contested.
function SeatClaim({
  sessionId,
  held,
  holder,
}: {
  sessionId: string
  held: boolean
  holder?: string
}): ReactElement | null {
  const [busy, setBusy] = useState(false)
  if (!held) return null

  const takeControl = async () => {
    setBusy(true)
    try {
      await sessionAPI.takeControl(sessionId)
    } catch {
      // Refusals keep their holder name; the next snapshot updates the badge.
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className="badge warn seat-claim"
      onClick={() => void takeControl()}
      disabled={busy}
    >
      {holder ? `seat: ${holder}` : 'seat held'}
    </button>
  )
}
